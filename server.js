const express = require("express");
const zlib = require("zlib");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { WebSocketServer } = require("ws");
const { ethers } = require("ethers");

const app = express();

// gzip text responses: index.html 126KB -> ~34KB on the wire
app.use((req, res, next) => {
  const ae = req.headers["accept-encoding"] || "";
  if (!/\bgzip\b/.test(ae)) return next();
  const _send = res.send.bind(res);
  const _json = res.json.bind(res);
  const gz = (body) => {
    try {
      if (typeof body !== "string" || body.length < 1024) return null;
      if (res.getHeader("Content-Encoding")) return null;
      // express infers Content-Type from what it's given: a string → text/html,
      // a Buffer → application/octet-stream (which makes browsers DOWNLOAD the page).
      // we're about to hand it a Buffer, so pin the type express would have chosen.
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", /^\s*[[{]/.test(body) ? "application/json; charset=utf-8" : "text/html; charset=utf-8");
      }
      const buf = zlib.gzipSync(Buffer.from(body), { level: 6 });
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      res.removeHeader("Content-Length");
      return buf;
    } catch (e) { return null; }
  };
  res.send = (body) => { const b = gz(body); return b ? _send(b) : _send(body); };
  res.json = (obj) => {
    const s = JSON.stringify(obj);
    const b = gz(s);
    if (!b) return _json(obj);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return _send(b);
  };
  next();
});
app.use(express.json({ limit: "4mb" })); // room for base64 logo uploads

const PAD = process.env.PAD_ADDRESS;
if (!PAD) console.log("⚠️  PAD_ADDRESS env var not set — site won't load tokens");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC);
const pad = PAD ? new ethers.Contract(PAD, [
  "function curves(address) view returns (uint ethReserve, uint tokReserve, uint realEth, address creator, bool migrated)"
], provider) : null;

// admin/config reads live on their own instance — `pad` above only knows curves()
const padCfg = PAD ? new ethers.Contract(PAD, [
  "function creationFee() view returns (uint)",
  "function migrationEth() view returns (uint)",
  "function feeWallet() view returns (address)",
  "function owner() view returns (address)"
], provider) : null;

// storage — railway volume at /data if mounted, else local (resets on redeploy)
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const IMG_DIR = path.join(DATA_DIR, "img");
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
const META_FILE = path.join(DATA_DIR, "meta.json");
let meta = {};
try { meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch (e) {}
const saveMeta = () => fs.writeFileSync(META_FILE, JSON.stringify(meta));

const clean = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const okUrl = (s) => !s || /^https?:\/\/[^\s]+$/i.test(s) || /^\/img\//.test(s);
const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// everything the client needs before first paint, read once server-side and cached.
// kills 5 sequential RPC round trips per page load.
let cfgCache = { ts: 0, data: null };
let ethUsdCache = { ts: 0, v: 0 };

async function warmEthUsd() {
  if (Date.now() - ethUsdCache.ts < 60_000 && ethUsdCache.v) return ethUsdCache.v;
  const srcs = [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => +j.data.amount],
    ["https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (j) => +j.price],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j.ethereum.usd],
  ];
  for (const [u, f] of srcs) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const v = f(await r.json());
      if (v > 0) { ethUsdCache = { ts: Date.now(), v }; return v; }
    } catch (e) {}
  }
  return ethUsdCache.v;
}

async function warmConfig() {
  try {
    if (!padCfg) return;
    const [creationFee, migrationEth, feeWallet, owner, ethUsd] = await Promise.all([
      padCfg.creationFee().catch(() => null),
      padCfg.migrationEth().catch(() => null),
      padCfg.feeWallet().catch(() => null),
      padCfg.owner().catch(() => null),
      warmEthUsd(),
    ]);
    let creatorPct = 50;
    if (feeWallet) {
      try {
        const v = new ethers.Contract(feeWallet, ["function globalMode() view returns (bool)"], provider);
        if (await v.globalMode()) creatorPct = 100;
      } catch (e) {}
    }
    cfgCache = {
      ts: Date.now(),
      data: {
        pad: PAD || "",
        locker: process.env.LOCKER_ADDRESS || "",
        creationFee: creationFee ? creationFee.toString() : null,
        migrationEth: migrationEth ? migrationEth.toString() : null,
        feeWallet: feeWallet || null,
        owner: owner || null,
        creatorPct,
        ethUsd,
      },
    };
  } catch (e) {}
}
warmConfig();
setInterval(warmConfig, 60_000);

app.get("/config", async (req, res) => {
  if (!cfgCache.data) await warmConfig();
  res.setHeader("Cache-Control", "public, max-age=20");
  res.json(cfgCache.data || { pad: PAD || "", locker: process.env.LOCKER_ADDRESS || "" });
});
app.get("/meta", (req, res) => res.json(meta));

// set token metadata — only the on-chain creator can, proven by wallet signature.
// imageData (optional): data-url of an uploaded logo, saved server-side.
app.post("/meta", async (req, res) => {
  try {
    const { token, image, telegram, x, website, sig, imageData } = req.body || {};
    if (!ethers.isAddress(token)) return res.status(400).json({ error: "bad token" });

    const message = "hoodpad-meta:" + token.toLowerCase();
    const signer = ethers.verifyMessage(message, sig);
    const curve = await pad.curves(token);
    if (signer.toLowerCase() !== curve.creator.toLowerCase())
      return res.status(403).json({ error: "only the token creator can edit" });

    const m = {
      image: clean(image, 500), telegram: clean(telegram, 200),
      x: clean(x, 200), website: clean(website, 200),
    };
    if (![m.image, m.telegram, m.x, m.website].every(okUrl))
      return res.status(400).json({ error: "links must start with http" });

    if (typeof imageData === "string" && imageData.startsWith("data:")) {
      const match = imageData.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return res.status(400).json({ error: "bad image (png/jpg/webp/gif only)" });
      const buf = Buffer.from(match[2], "base64");
      if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: "image over 2MB" });
      const file = token.toLowerCase() + "." + MIME_EXT[match[1]];
      // remove older logo with a different extension
      for (const ext of Object.values(MIME_EXT)) {
        const old = path.join(IMG_DIR, token.toLowerCase() + "." + ext);
        if (old !== path.join(IMG_DIR, file) && fs.existsSync(old)) fs.unlinkSync(old);
      }
      fs.writeFileSync(path.join(IMG_DIR, file), buf);
      m.image = "/img/" + file;
    }

    meta[token.toLowerCase()] = m;
    saveMeta();
    res.json({ ok: true, image: m.image });
  } catch (e) { res.status(400).json({ error: "verification failed" }); }
});

// serve uploaded logos — filename is validated to address.ext only
app.get("/img/:file", (req, res) => {
  if (!/^0x[0-9a-f]{40}\.(png|jpg|webp|gif)$/.test(req.params.file)) return res.status(404).end();
  const p = path.join(IMG_DIR, req.params.file);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(p);
});

app.get("/logo.png", (req, res) => { res.setHeader("Cache-Control", "public, max-age=86400"); res.sendFile(path.join(__dirname, "logo.png")); });
for (const f of ["logo-wide.png", "logo-dark.png", "logo-light.png"]) {
  app.get("/" + f, (req, res) => { res.setHeader("Cache-Control", "public, max-age=86400"); res.sendFile(path.join(__dirname, f)); });
}
// index.html served from memory (gzipped by the middleware above)
let indexCache = null;
function readIndex() {
  try { indexCache = fs.readFileSync(path.join(__dirname, "index.html"), "utf8"); } catch (e) {}
  return indexCache;
}
readIndex();
function sendIndex(res, req) {
  if (req) noteVisitor(req);
  const html = indexCache || readIndex();
  if (!html) return res.status(500).send("index missing");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // no-cache = "always ask if it changed". with ETag that's a tiny 304 when it hasn't,
  // and the new build the instant it has. this is what kills the hard-refresh ritual.
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.send(html);
}
app.get("/", (req, res) => sendIndex(res, req));

// ---- realtime: websocket push of trades & launches (~2.5s from chain) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---- live visitors: every open tab holds a ws connection, so counting them is free.
// ips are hashed (never stored raw) and only used to tell people apart.
const crypto = require("crypto");
const VISIT_FILE = path.join(DATA_DIR, "visits.json");
const SALT = "robn-" + (PAD || "x");
let visits = { day: "", uniq: [], views: 0, peak: 0, best: 0 };
try { visits = Object.assign(visits, JSON.parse(fs.readFileSync(VISIT_FILE, "utf8"))); } catch (e) {}
const hashIp = (ip) => crypto.createHash("sha256").update(SALT + ip).digest("hex").slice(0, 16);
function today() { return new Date().toISOString().slice(0, 10); }
function rollDay() {
  const d = today();
  if (visits.day !== d) {
    if (visits.peak > (visits.best || 0)) visits.best = visits.peak;
    visits = { day: d, uniq: [], views: 0, peak: 0, best: visits.best || 0 };
  }
}
function noteVisitor(req) {
  try {
    rollDay();
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
    if (!ip) return;
    const h = hashIp(ip);
    visits.views++;
    if (!visits.uniq.includes(h)) visits.uniq.push(h);
    if (visits.uniq.length > 20000) visits.uniq = visits.uniq.slice(-20000);
    fs.writeFileSync(VISIT_FILE, JSON.stringify(visits));
  } catch (e) {}
}
const liveIps = new Map(); // hashed ip -> open tab count
wss.on("connection", (ws, req) => {
  try {
    rollDay();
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
    const h = ip ? hashIp(ip) : "?";
    ws._ipHash = h;
    liveIps.set(h, (liveIps.get(h) || 0) + 1);
    if (liveIps.size > (visits.peak || 0)) { visits.peak = liveIps.size; try { fs.writeFileSync(VISIT_FILE, JSON.stringify(visits)); } catch (e) {} }
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw).slice(0, 200));
        if (m && m.watch !== undefined) { m.watch ? watchPool(ws, m.watch) : unwatchPool(ws); }
      } catch (e) {}
    });
    ws.on("close", () => {
      unwatchPool(ws);
      const n = (liveIps.get(h) || 1) - 1;
      if (n <= 0) liveIps.delete(h); else liveIps.set(h, n);
    });
  } catch (e) {}
});

app.get("/api/live", (req, res) => {
  rollDay();
  res.json({
    live: liveIps.size,            // people on the site right now (unique, not tabs)
    tabs: wss.clients.size,        // open tabs
    uniqueToday: visits.uniq.length,
    viewsToday: visits.views,
    peakToday: visits.peak || 0,
    bestEver: visits.best || 0,
  });
});

// ---- live pool prices for /x/ pairs ----
// ONE chain read per pool per tick, no matter how many people are watching it.
// pool metadata (tokens/decimals/version) never changes, so it's read once and kept.
const V3_POOL_ABI_S = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)",
];
const V2_PAIR_ABI_S = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
];
const WETH_S = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const poolMeta = new Map();   // pair -> { v3, wethIs0, dec, c } | null when unusable
const poolWatch = new Map();  // pair -> subscriber count
const poolLast = new Map();   // pair -> last price (so a new viewer gets a value instantly)

async function getPoolMeta(pair) {
  if (poolMeta.has(pair)) return poolMeta.get(pair);
  let meta = null;
  try {
    const W = WETH_S.toLowerCase();
    let c = new ethers.Contract(pair, V3_POOL_ABI_S, provider), v3 = true, t0, t1;
    try { [t0, t1] = await Promise.all([c.token0(), c.token1()]); await c.fee(); }
    catch (e) { c = new ethers.Contract(pair, V2_PAIR_ABI_S, provider); v3 = false; [t0, t1] = await Promise.all([c.token0(), c.token1()]); }
    const a = t0.toLowerCase(), b = t1.toLowerCase();
    if (a === W || b === W) {
      const wethIs0 = a === W;
      const token = wethIs0 ? t1 : t0;
      let dec = 18;
      try { dec = Number(await new ethers.Contract(token, ["function decimals() view returns (uint8)"], provider).decimals()); } catch (e) {}
      meta = { v3, wethIs0, dec, c };
    }
  } catch (e) { meta = null; }
  poolMeta.set(pair, meta);
  return meta;
}

async function readPoolPrice(pair) {
  const m = await getPoolMeta(pair);
  if (!m) return null;
  const usd = ethUsdCache.v || (await warmEthUsd());
  if (!usd) return null;
  try {
    let ethPerToken = null;
    if (m.v3) {
      const s = await m.c.slot0();
      const raw = (Number(s[0]) / 2 ** 96) ** 2;
      ethPerToken = m.wethIs0 ? 1 / (raw * 10 ** 18 / 10 ** m.dec) : raw * 10 ** m.dec / 10 ** 18;
    } else {
      const r = await m.c.getReserves();
      const rw = m.wethIs0 ? r[0] : r[1], rt = m.wethIs0 ? r[1] : r[0];
      if (rw > 0n && rt > 0n) ethPerToken = (Number(rw) / 1e18) / (Number(rt) / 10 ** m.dec);
    }
    if (!ethPerToken || !isFinite(ethPerToken)) return null;
    return ethPerToken * usd;
  } catch (e) { return null; }
}

// Swap event signatures — v2 and v3 differ, and poolMeta already knows which we have
const SWAP_V2_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_V3_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,int128,int24)");
const v2Iface = new ethers.Interface(["event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"]);
const v3Iface = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, int128 liquidity, int24 tick)"]);
const poolLogBlock = new Map(); // pair -> last block scanned

async function poolTrades(pair, meta, usd) {
  try {
    const latest = await provider.getBlockNumber();
    let from = poolLogBlock.get(pair);
    if (from === undefined) { poolLogBlock.set(pair, latest); return []; } // first tick: start from now
    if (latest <= from) return [];
    from = Math.max(from + 1, latest - 400); // never scan a huge range after a restart
    const logs = await provider.getLogs({
      address: pair, fromBlock: from, toBlock: latest,
      topics: [meta.v3 ? SWAP_V3_TOPIC : SWAP_V2_TOPIC],
    });
    poolLogBlock.set(pair, latest);
    const out = [];
    for (const lg of logs) {
      try {
        let ethIn = 0n, ethOut = 0n;
        if (meta.v3) {
          const e = v3Iface.parseLog(lg);
          const wethAmt = meta.wethIs0 ? e.args.amount0 : e.args.amount1; // positive = into the pool
          if (wethAmt > 0n) ethIn = wethAmt; else ethOut = -wethAmt;
        } else {
          const e = v2Iface.parseLog(lg);
          ethIn = meta.wethIs0 ? e.args.amount0In : e.args.amount1In;
          ethOut = meta.wethIs0 ? e.args.amount0Out : e.args.amount1Out;
        }
        const buy = ethIn > 0n;                       // eth into the pool = someone bought the token
        const amt = buy ? ethIn : ethOut;
        const eth = Number(ethers.formatEther(amt));
        if (!eth) continue;
        out.push({ buy, usd: eth * usd, eth, tx: lg.transactionHash });
      } catch (e) {}
    }
    if (out.length) console.log("📊 " + pair.slice(0, 10) + ": " + out.length + " swap(s) → " + out.map((t) => (t.buy ? "BUY $" : "SELL $") + t.usd.toFixed(0)).join(", "));
    return out;
  } catch (e) {
    if (!poolLogWarned) { poolLogWarned = true; console.log("⚠️ swap-log scan failed — the live feed will stay empty:", e.shortMessage || e.message); }
    return [];
  }
}
let poolLogWarned = false;

// open robn.fun/api/pooldebug/<pair> — runs the real scan path and reports where it stops
app.get("/api/pooldebug/:pair", async (req, res) => {
  const pair = String(req.params.pair || "").toLowerCase();
  const out = { pair, watching: poolWatch.has(pair), cursor: poolLogBlock.get(pair) ?? null, ethUsd: ethUsdCache.v || null };
  try {
    const meta = await getPoolMeta(pair);
    out.meta = meta ? { version: meta.v3 ? "v3" : "v2", wethIsToken0: meta.wethIs0, decimals: meta.dec } : "NOT AN ETH PAIR or unreadable";
    if (!meta) return res.json(out);
    const latest = await provider.getBlockNumber();
    out.latestBlock = latest;
    const topic = meta.v3 ? SWAP_V3_TOPIC : SWAP_V2_TOPIC;
    out.topicUsed = topic;
    for (const span of [200, 2000, 20000]) {
      try {
        const logs = await provider.getLogs({ address: pair, fromBlock: latest - span, toBlock: latest, topics: [topic] });
        out["swapsInLast" + span] = logs.length;
        if (logs.length && !out.lastSwapTx) out.lastSwapTx = logs[logs.length - 1].transactionHash;
      } catch (e) { out["swapsInLast" + span] = "RPC ERROR: " + (e.shortMessage || e.message); break; }
    }
    try {
      const any = await provider.getLogs({ address: pair, fromBlock: latest - 2000, toBlock: latest });
      out.anyEventsLast2000 = any.length;
      out.topicsSeen = [...new Set(any.map((l) => l.topics[0]))].slice(0, 6);
    } catch (e) { out.anyEventsLast2000 = "RPC ERROR: " + (e.shortMessage || e.message); }
  } catch (e) { out.error = e.shortMessage || e.message; }
  res.json(out);
});

async function poolTick() {
  const pairs = [...poolWatch.keys()];
  if (!pairs.length) return;
  await Promise.all(pairs.map(async (pair) => {
    const price = await readPoolPrice(pair);
    if (price === null) return;
    poolLast.set(pair, price);
    const meta = await getPoolMeta(pair);
    const trades = meta ? await poolTrades(pair, meta, ethUsdCache.v || 0) : [];
    const msg = JSON.stringify({ type: "xprice", pair, price, trades });
    for (const c of wss.clients) {
      if (c.readyState === 1 && c._watching === pair) { try { c.send(msg); } catch (e) {} }
    }
  }));
}
setInterval(poolTick, 1200); // watched pools only — busy pairs move a lot between ticks

function watchPool(ws, pair) {
  unwatchPool(ws);
  if (!/^0x[0-9a-fA-F]{40}$/.test(pair || "")) return;
  pair = pair.toLowerCase();
  ws._watching = pair;
  poolWatch.set(pair, (poolWatch.get(pair) || 0) + 1);
  const last = poolLast.get(pair);
  if (last) { try { ws.send(JSON.stringify({ type: "xprice", pair, price: last })); } catch (e) {} }
  else readPoolPrice(pair).then((p) => { if (p !== null) { poolLast.set(pair, p); try { ws.send(JSON.stringify({ type: "xprice", pair, price: p })); } catch (e) {} } });
}
function unwatchPool(ws) {
  const p = ws._watching;
  if (!p) return;
  const n = (poolWatch.get(p) || 1) - 1;
  if (n <= 0) { poolWatch.delete(p); poolLogBlock.delete(p); } else poolWatch.set(p, n);
  ws._watching = null;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) { if (c.readyState === 1) { try { c.send(data); } catch (e) {} } }
}

let wsLastBlock = 0;
async function fastWatch() {
  if (!PAD) return;
  try {
    const latest = await provider.getBlockNumber();
    if (!wsLastBlock) { wsLastBlock = latest; return; }
    if (latest <= wsLastBlock) return;
    const logs = await provider.getLogs({ address: PAD, fromBlock: wsLastBlock + 1, toBlock: latest });
    wsLastBlock = latest;
    for (const log of logs) {
      let p; try { p = padIface.parseLog(log); } catch (e) { continue; }
      if (!p) continue;
      if (p.name === "TokenCreated") {
        broadcast({ t: "created", token: p.args.token, name: p.args.name, symbol: p.args.symbol, creator: p.args.creator });
      }
      if (p.name === "Buy" || p.name === "Sell") {
        const tok = p.args.token;
        let extra = {};
        try {
          const [price, curve, prog] = await Promise.all([padRead.priceWei(tok), padRead.curves(tok), padRead.progress(tok)]);
          extra = { price: price.toString(), realEth: curve.realEth.toString(), prog: Number(prog), migrated: curve.migrated };
        } catch (e) {}
        broadcast({
          t: "trade", token: tok, side: p.name === "Buy" ? "buy" : "sell",
          who: p.name === "Buy" ? p.args.buyer : p.args.seller,
          eth: (p.name === "Buy" ? p.args.ethIn : p.args.ethOut).toString(),
          tx: log.transactionHash, ...extra,
        });
      }
      if (p.name === "Migrated") broadcast({ t: "migrated", token: p.args.token });
    }
  } catch (e) {}
}
setInterval(fastWatch, 2500);

// (chain trade watcher removed — ticker covers chain activity now)

// ================= FeeVault auto-payer =================
// pays creators automatically. finds the vault by asking the pad where fees go,
// so a redeployed vault needs zero config. uses a throwaway bot wallet whose only
// powers are: trigger sync/claim (money can only reach creators) + spend own gas.
const VAULT_ABI2 = [
  "function owed(address token) view returns (uint256)",
  "function claim(address token)",
  "function sync(address token)",
  "function synced(address token) view returns (bool)",
  "function eligible(address token) view returns (bool)",
  "function globalMode() view returns (bool)",
  "function vipToken(address) view returns (bool)",
  "event VIPAdded(address indexed token, uint256 baseline)",
  "event VIPRemoved(address indexed token)",
];
const BOT_FILE = path.join(DATA_DIR, "claimbot.json");
let claimBot = null, vipSet = new Set(), vipScanned = 0, botLowWarned = false, botVault = null;

function loadClaimBot() {
  try {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(BOT_FILE, "utf8")); } catch (e) {}
    if (!st || !st.key) {
      const w = ethers.Wallet.createRandom();
      st = { key: w.privateKey, lastBlock: 0, vips: [] };
      fs.writeFileSync(BOT_FILE, JSON.stringify(st));
    }
    claimBot = new ethers.Wallet(st.key, provider);
    vipSet = new Set(st.vips || []);
    vipScanned = st.lastBlock || 0;
    console.log("🤖 fee bot wallet:", claimBot.address, "— fund it with ~0.002 ETH for gas (one time)");
  } catch (e) { console.log("fee bot init failed:", e.message); }
}
function saveClaimBot() {
  try { fs.writeFileSync(BOT_FILE, JSON.stringify({ key: claimBot.privateKey, lastBlock: vipScanned, vips: [...vipSet] })); } catch (e) {}
}

// the pad's feeWallet IS the vault (if it's a vault at all)
async function findVault() {
  try {
    if (!padCfg) return null;
    const fw = await padCfg.feeWallet();
    if (botVault && botVault.addr.toLowerCase() === fw.toLowerCase()) return botVault;
    const c = new ethers.Contract(fw, VAULT_ABI2, claimBot);
    await c.globalMode(); // throws if feeWallet is a plain wallet
    botVault = { addr: fw, c };
    vipSet = new Set(); vipScanned = 0; // new vault: rescan
    console.log("🤖 vault detected at", fw);
    return botVault;
  } catch (e) { botVault = null; return null; }
}

async function scanVIPs(vault) {
  const latest = await provider.getBlockNumber();
  if (!vipScanned) vipScanned = Math.max(0, latest - 40000);
  let from = vipScanned + 1;
  while (from <= latest) {
    const to = Math.min(from + 9000, latest);
    try {
      const [adds, rems] = await Promise.all([
        vault.c.queryFilter(vault.c.filters.VIPAdded(), from, to),
        vault.c.queryFilter(vault.c.filters.VIPRemoved(), from, to),
      ]);
      const evs = [...adds.map((e) => ({ b: e.blockNumber, i: e.index, t: e.args.token.toLowerCase(), add: true })),
                   ...rems.map((e) => ({ b: e.blockNumber, i: e.index, t: e.args.token.toLowerCase(), add: false }))]
        .sort((a, b) => a.b - b.b || a.i - b.i);
      for (const ev of evs) { if (ev.add) vipSet.add(ev.t); else vipSet.delete(ev.t); }
      vipScanned = to;
    } catch (e) { break; }
    from = to + 1;
  }
  saveClaimBot();
}

async function autoPay() {
  try {
    if (!claimBot) return;
    const vault = await findVault();
    if (!vault) return; // fees go straight to his wallet — nothing to do
    const isGlobal = await vault.c.globalMode();
    await scanVIPs(vault);
    const targets = isGlobal
      ? (tokenCache.tokens || []).map((t) => t.addr.toLowerCase())
      : [...vipSet];
    if (!targets.length) return;
    const bal = await provider.getBalance(claimBot.address);
    if (bal < ethers.parseEther("0.0002")) {
      if (!botLowWarned) { console.log("🤖 fee bot out of gas — send ~0.002 ETH to", claimBot.address); botLowWarned = true; }
      return;
    }
    botLowWarned = false;
    for (const tok of targets) {
      try {
        if (!(await vault.c.eligible(tok))) continue;
        if (!(await vault.c.synced(tok))) {
          const tx = await vault.c.sync(tok); await tx.wait();
          console.log("🤖 synced baseline for", tok);
          continue; // pay from the next cycle
        }
        const owed = await vault.c.owed(tok);
        if (owed >= ethers.parseEther("0.00005")) {
          const tx = await vault.c.claim(tok); await tx.wait();
          console.log("🤖 paid", ethers.formatEther(owed), "ETH to the creator of", tok);
        }
      } catch (e) {}
    }
  } catch (e) {}
}
loadClaimBot();
setInterval(autoPay, 5 * 60 * 1000);
setTimeout(autoPay, 20 * 1000);
// ===========================================================

// keep the pool list warm: gentle sequential fetches, timeouts, ~9 req/cycle
function gtGet(u) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  return fetch(u, { headers: { accept: "application/json" }, signal: ctl.signal })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null).finally(() => clearTimeout(timer));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warming = false;
async function warmTrenches() {
  if (warming) return;
  warming = true;
  try {
    const clean = (j) => (j && j.data ? j.data.map(mapPool).filter(Boolean) : []);
    const results = [];
    const urls = [
      GT + "/trending_pools",
      ...[1, 2, 3, 4, 5, 6].map((p) => GT + "/pools?sort=h24_volume_usd_desc&page=" + p),
      GT + "/new_pools?page=1", GT + "/new_pools?page=2",
    ];
    for (const u of urls) { results.push(await gtGet(u)); await sleep(350); }
    const seen = new Set();
    const top = results.slice(1, 7).flatMap(clean).filter((p) => !seen.has(p.pair) && seen.add(p.pair));
    const seen2 = new Set();
    const fresh = results.slice(7).flatMap(clean).filter((p) => !seen2.has(p.pair) && seen2.add(p.pair));
    const data = { ts: Date.now(), trending: clean(results[0]), top, fresh };
    if (data.trending.length || data.top.length || data.fresh.length) trenchCache = { ts: Date.now(), data };
  } catch (e) {} finally { warming = false; }
}
warmTrenches();
setInterval(() => { if (!trenchCache.data) warmTrenches(); }, 12000); // fast retry until first success
setInterval(warmTrenches, 60000);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("hoodpad site running on " + port));

// ---- price recorder for charts (1-min ticks, kept in /data) ----
const PRICES_FILE = path.join(DATA_DIR, "prices.json");
let prices = {};
try { prices = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8")); } catch (e) {}
const padFull = PAD ? new ethers.Contract(PAD, [
  "function tokenCount() view returns (uint)",
  "function allTokens(uint) view returns (address)",
  "function priceWei(address) view returns (uint)"
], provider) : null;

async function recordPrices() {
  if (!padFull) return;
  try {
    const n = Number(await padFull.tokenCount());
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < n; i++) {
      const a = (await padFull.allTokens(i)).toLowerCase();
      try {
        const p = await padFull.priceWei(a);
        if (!prices[a]) prices[a] = [];
        const arr = prices[a];
        arr.push([now, p.toString()]);
        if (arr.length > 2000) prices[a] = arr.slice(-2000);
      } catch (e) {}
    }
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices));
  } catch (e) {}
}
setInterval(recordPrices, 60_000);
recordPrices();

// ---- token list cache: one fast /tokens fetch instead of dozens of RPC calls per visitor ----
let tokenCache = { ts: 0, tokens: [] };
const nameCache = {};
const padRead = PAD ? new ethers.Contract(PAD, [
  "function tokenCount() view returns (uint)",
  "function allTokens(uint) view returns (address)",
  "function curves(address) view returns (uint ethReserve, uint tokReserve, uint realEth, address creator, bool migrated)",
  "function priceWei(address) view returns (uint)",
  "function progress(address) view returns (uint)",
  "function creatorFeesEarned(address) view returns (uint)"
], provider) : null;

async function buildTokenCache() {
  if (!padRead) return;
  try {
    const n = Number(await padRead.tokenCount());
    const idx = [...Array(n).keys()];
    const addrs = await Promise.all(idx.map((i) => padRead.allTokens(i)));
    const items = (await Promise.all(addrs.map(async (addr, i) => {
      try {
      const a = addr.toLowerCase();
      if (!nameCache[a]) {
        const t = new ethers.Contract(a, ["function name() view returns (string)", "function symbol() view returns (string)"], provider);
        nameCache[a] = { name: await t.name(), symbol: await t.symbol() };
      }
      const [curve, price, prog, cFees] = await Promise.all([padRead.curves(a), padRead.priceWei(a), padRead.progress(a), padRead.creatorFeesEarned(a).catch(() => 0n)]);
      const st = stats.perToken[a] || {};
      return {
        addr, i, name: nameCache[a].name, symbol: nameCache[a].symbol,
        migrated: curve.migrated, realEth: curve.realEth.toString(),
        price: price.toString(), prog: Number(prog),
        creator: curve.creator, meta: meta[a] || {},
        created: st.created || (prices[a] && prices[a][0] ? prices[a][0][0] : null),
        trades: st.trades || 0,
        creatorFees: cFees.toString(),
        vol24: (st.t24 || []).filter((x) => x[0] > Date.now() - 86_400_000).reduce((s, x) => s + BigInt(x[1]), 0n).toString(),
      };
      } catch (e) { return null; }
    }))).filter(Boolean);
    tokenCache = { ts: Math.floor(Date.now() / 1000), tokens: items };
  } catch (e) {}
}
setInterval(buildTokenCache, 12_000);
buildTokenCache();

app.get("/tokens", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=5");
  res.json(tokenCache);
});

app.get("/prices/:token", (req, res) => {
  const t = (req.params.token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return res.status(400).json([]);
  res.json(prices[t] || []);
});

// token pages — same app, client-side routing
app.get("/api/creators", (req, res) => {
  const agg = {};
  for (const t of tokenCache.tokens || []) {
    if (!t.creator) continue;
    const c = t.creator.toLowerCase();
    if (!agg[c]) agg[c] = { fees: 0n, launches: 0, top: null };
    agg[c].fees += BigInt(t.creatorFees || "0");
    agg[c].launches++;
    if (!agg[c].top || Number(t.mcapUsd || 0) > agg[c].topM) { agg[c].top = t.symbol; agg[c].topM = Number(t.mcapUsd || 0); }
  }
  const rows = Object.entries(agg).map(([a, v]) => ({ addr: a, fees: v.fees.toString(), launches: v.launches, top: v.top }))
    .sort((x, y) => (BigInt(y.fees) > BigInt(x.fees) ? 1 : -1)).slice(0, 50);
  res.json({ creators: rows });
});

// 2) referral attribution (light v1)
const REFS_FILE = path.join(DATA_DIR, "refs.json");
let refs = {};
try { refs = JSON.parse(fs.readFileSync(REFS_FILE, "utf8")); } catch (e) {}
app.post("/ref", (req, res) => {
  try {
    const { user, ref } = req.body || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(user || "") || !/^0x[0-9a-fA-F]{40}$/.test(ref || "")) return res.json({ ok: false });
    const u = user.toLowerCase(), r = ref.toLowerCase();
    if (u === r || refs[u]) return res.json({ ok: false }); // first ref sticks, no self-refs
    refs[u] = r;
    fs.writeFileSync(REFS_FILE, JSON.stringify(refs));
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// 3) link-preview meta injection for token pages
let indexHtml = "";
try { indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8"); } catch (e) {}
app.get("/t/:token", (req, res) => {
  try {
    const a = (req.params.token || "").toLowerCase();
    const t = (tokenCache.tokens || []).find((x) => x.addr.toLowerCase() === a);
    if (t && indexHtml) {
      const title = `${t.name} ($${t.symbol}) — robn.fun`;
      const desc = `trade $${t.symbol} on robn.fun · the launchpad + terminal of robinhood chain · creators earn 50% of every trade fee`;
      const img = t.meta && t.meta.image && t.meta.image.startsWith("/img/") ? "https://robn.fun" + t.meta.image : "https://robn.fun/logo.png";
      let html = indexHtml.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
      html = html.replace("</head>", `<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:image" content="${img}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${desc}"><meta name="twitter:image" content="${img}"></head>`);
      // set these HERE, not in middleware: the og-injection path bypasses sendIndex,
      // so without them express guesses octet-stream (browser downloads the page) and
      // the browser heuristically caches whatever it got.
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      return res.send(html);
    }
  } catch (e) {}
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/creators", (req, res) => sendIndex(res, req));
app.get("/vault-admin", (req, res) => res.sendFile(path.join(__dirname, "vault-admin.html")));
app.get("/lock", (req, res) => res.sendFile(path.join(__dirname, "lock.html")));

// ---- analytics indexer ----
const STATS_FILE = path.join(DATA_DIR, "stats.json");
let stats = { lastBlock: 0, vol: "0", fees: "0", buys: 0, sells: 0, launches: 0, migrations: 0, traders: {}, daily: {}, perToken: {}, traderVol: {}, creatorLaunches: {} };
try { stats = Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, "utf8"))); } catch (e) {}
if (!stats.traderVol || !stats.creatorLaunches) { // points upgrade -> full reindex
  stats = { lastBlock: 0, vol: "0", fees: "0", buys: 0, sells: 0, launches: 0, migrations: 0, traders: {}, daily: {}, perToken: {}, traderVol: {}, creatorLaunches: {} };
}
if (stats.pad !== PAD) { // pad redeployed -> start stats fresh
  stats = { pad: PAD, lastBlock: 0, vol: "0", fees: "0", buys: 0, sells: 0, launches: 0, migrations: 0, traders: {}, daily: {}, perToken: {}, traderVol: {}, creatorLaunches: {}, holders: {}, tokenList: [], creatorOf: {} };
}
if (!stats.holders || !stats.tokenList) { // holders upgrade -> full reindex
  stats = { pad: PAD, lastBlock: 0, vol: "0", fees: "0", buys: 0, sells: 0, launches: 0, migrations: 0, traders: {}, daily: {}, perToken: {}, traderVol: {}, creatorLaunches: {}, holders: {}, tokenList: [], creatorOf: {} };
}
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const padIface = new ethers.Interface([
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol)",
  "event Buy(address indexed token, address indexed buyer, uint ethIn, uint tokensOut)",
  "event Sell(address indexed token, address indexed seller, uint tokensIn, uint ethOut, uint taxEth)",
  "event Migrated(address indexed token, uint ethToLp, uint tokensToLp)"
]);

function addWei(a, b) { return (BigInt(a) + b).toString(); }
function pushT24(tok, wei) {
  const k = tok.toLowerCase();
  if (!stats.perToken[k]) stats.perToken[k] = { vol: "0", trades: 0 };
  if (!stats.perToken[k].t24) stats.perToken[k].t24 = [];
  const arr = stats.perToken[k].t24;
  arr.push([Date.now(), wei.toString()]);
  const cutoff = Date.now() - 86_400_000;
  while (arr.length && arr[0][0] < cutoff) arr.shift();
  if (arr.length > 800) arr.splice(0, arr.length - 800);
}

function bump(tok, wei) {
  const k = tok.toLowerCase();
  if (!stats.perToken[k]) stats.perToken[k] = { vol: "0", trades: 0 };
  stats.perToken[k].vol = addWei(stats.perToken[k].vol, wei);
  stats.perToken[k].trades++;
}

async function indexStats() {
  if (!PAD) return;
  try {
    const latest = await provider.getBlockNumber();
    let from = stats.lastBlock ? stats.lastBlock + 1 : Math.max(0, latest - 200000);
    if (from > latest) return;
    const day = new Date().toISOString().slice(0, 10);
    while (from <= latest) {
      const to = Math.min(from + 9999, latest);
      const logs = await provider.getLogs({ address: PAD, fromBlock: from, toBlock: to });
      for (const log of logs) {
        let p; try { p = padIface.parseLog(log); } catch (e) { continue; }
        if (!p) continue;
        if (p.name === "TokenCreated") {
          stats.launches++;
          try {
            const b = await provider.getBlock(log.blockNumber);
            const k = p.args.token.toLowerCase();
            if (!stats.perToken[k]) stats.perToken[k] = { vol: "0", trades: 0 };
            stats.perToken[k].created = b.timestamp;
          } catch (e) {}
          const cr = p.args.creator.toLowerCase();
          stats.creatorLaunches[cr] = (stats.creatorLaunches[cr] || 0) + 1;
          const tk = p.args.token.toLowerCase();
          if (!stats.tokenList.includes(tk)) stats.tokenList.push(tk);
          stats.creatorOf[tk] = cr;
        }
        if (p.name === "Migrated") stats.migrations++;
        if (p.name === "Buy") {
          stats.buys++;
          stats.vol = addWei(stats.vol, p.args.ethIn);
          stats.fees = addWei(stats.fees, p.args.ethIn / 100n);
          stats.daily[day] = addWei(stats.daily[day] || "0", p.args.ethIn);
          if (Object.keys(stats.traders).length < 100000) stats.traders[p.args.buyer.toLowerCase()] = 1;
          stats.traderVol[p.args.buyer.toLowerCase()] = addWei(stats.traderVol[p.args.buyer.toLowerCase()] || "0", p.args.ethIn);
          bump(p.args.token, p.args.ethIn);
          pushT24(p.args.token, p.args.ethIn);
        }
        if (p.name === "Sell") {
          stats.sells++;
          stats.vol = addWei(stats.vol, p.args.ethOut);
          stats.fees = addWei(stats.fees, p.args.taxEth);
          stats.daily[day] = addWei(stats.daily[day] || "0", p.args.ethOut);
          if (Object.keys(stats.traders).length < 100000) stats.traders[p.args.seller.toLowerCase()] = 1;
          stats.traderVol[p.args.seller.toLowerCase()] = addWei(stats.traderVol[p.args.seller.toLowerCase()] || "0", p.args.ethOut);
          bump(p.args.token, p.args.ethOut);
          pushT24(p.args.token, p.args.ethOut);
        }
      }
      // holder balances: Transfer events for every known token in this range
      for (const tk of stats.tokenList) {
        try {
          const tlogs = await provider.getLogs({ address: tk, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to });
          if (!stats.holders[tk]) stats.holders[tk] = {};
          const bal = stats.holders[tk];
          for (const l of tlogs) {
            const fromA = ("0x" + l.topics[1].slice(26)).toLowerCase();
            const toA = ("0x" + l.topics[2].slice(26)).toLowerCase();
            const v = BigInt(l.data);
            if (fromA !== "0x0000000000000000000000000000000000000000") {
              bal[fromA] = (BigInt(bal[fromA] || "0") - v).toString();
              if (BigInt(bal[fromA]) <= 0n) delete bal[fromA];
            }
            if (toA !== "0x0000000000000000000000000000000000000000") {
              bal[toA] = (BigInt(bal[toA] || "0") + v).toString();
            }
          }
        } catch (e) {}
      }
      from = to + 1;
    }
    stats.lastBlock = latest;
    // keep only last 30 daily buckets
    const days = Object.keys(stats.daily).sort();
    while (days.length > 30) delete stats.daily[days.shift()];
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
  } catch (e) {}
}
setInterval(indexStats, 60_000);
indexStats();

app.get("/stats", (req, res) => {
  for (const [k, arr] of Object.entries(prices)) {
    if (arr.length && stats.perToken[k] && !stats.perToken[k].created) stats.perToken[k].created = arr[0][0];
    if (arr.length && !stats.perToken[k]) stats.perToken[k] = { vol: "0", trades: 0, created: arr[0][0] };
  }
  res.json({
    vol: stats.vol, buys: stats.buys, sells: stats.sells,
    launches: stats.launches, migrations: stats.migrations,
    traders: Object.keys(stats.traders).length,
    daily: stats.daily, perToken: stats.perToken,
  });
});

app.get("/analytics", (req, res) => sendIndex(res, req));
app.get("/trenches", (req, res) => sendIndex(res, req));
app.get("/x/:pair", (req, res) => sendIndex(res, req));

// hood-chain-wide token data via geckoterminal (free api, cached 30s)
let trenchCache = { ts: 0, data: null };
const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";
function mapPool(d) {
  try {
    const a = d.attributes;
    return {
      pair: a.address,
      name: a.name,
      priceUsd: Number(a.base_token_price_usd),
      ch: { m5: Number(a.price_change_percentage?.m5), h1: Number(a.price_change_percentage?.h1), h6: Number(a.price_change_percentage?.h6), h24: Number(a.price_change_percentage?.h24) },
      vol24: Number(a.volume_usd?.h24),
      liq: Number(a.reserve_in_usd),
      fdv: Number(a.fdv_usd),
      mcap: Number(a.market_cap_usd) || Number(a.fdv_usd) || null,
      created: a.pool_created_at,
      dex: d.relationships?.dex?.data?.id || "",
      token: (d.relationships?.base_token?.data?.id || "").split("_").pop() || null,
    };
  } catch (e) { return null; }
}
const poolCache = new Map();
app.get("/api/pool/:pair", async (req, res) => {
  try {
    const pair = String(req.params.pair || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(pair)) return res.json({ pool: null });
    const hit = poolCache.get(pair);
    if (hit && Date.now() - hit.ts < 60_000) return res.json(hit.data);
    const j = await fetch(GT + "/pools/" + pair, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const data = { pool: j && j.data ? mapPool(j.data) : null };
    poolCache.set(pair, { ts: Date.now(), data });
    if (poolCache.size > 500) poolCache.clear();
    res.json(data);
  } catch (e) { res.json({ pool: null }); }
});

const searchCache = new Map();
app.get("/api/poolsearch", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 64);
    if (q.length < 2) return res.json({ pools: [] });
    const hit = searchCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.ts < 60_000) return res.json(hit.data);
    let pools = [];
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      const j = await fetch(GT + "/tokens/" + q + "/pools", { headers: { accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      pools = j && j.data ? j.data.map(mapPool).filter(Boolean) : [];
    } else {
      const j = await fetch("https://api.geckoterminal.com/api/v2/search/pools?query=" + encodeURIComponent(q) + "&network=robinhood", { headers: { accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      pools = j && j.data ? j.data.map(mapPool).filter(Boolean) : [];
    }
    const data = { pools: pools.slice(0, 10) };
    searchCache.set(q.toLowerCase(), { ts: Date.now(), data });
    if (searchCache.size > 500) searchCache.clear();
    res.json(data);
  } catch (e) { res.json({ pools: [] }); }
});

app.get("/api/trenches", (req, res) => {
  res.json(trenchCache.data || { ts: Date.now(), trending: [], top: [], fresh: [] });
});

// season 1 points: 1000 pts per ETH traded + 500 per token launched
app.get("/points", (req, res) => {
  // base points computed below; referral bonus applied after
  const pts = {};
  for (const [a, wei] of Object.entries(stats.traderVol || {})) {
    pts[a] = (pts[a] || 0) + Number(BigInt(wei) / 1000000000000000n) / 1000; // eth with 3dp
  }
  for (const a of Object.keys(pts)) pts[a] = Math.floor(pts[a] * 1000);
  for (const [a, n] of Object.entries(stats.creatorLaunches || {})) {
    pts[a] = (pts[a] || 0) + n * 500;
  }
  // referral bonus: referrer earns +10% of each referee's points
  for (const [user, referrer] of Object.entries(refs)) {
    if (pts[user]) pts[referrer] = (pts[referrer] || 0) + Math.floor(pts[user] * 0.1);
  }
  const board = Object.entries(pts).map(([a, p]) => ({ a, p })).sort((x, y) => y.p - x.p).slice(0, 100);
  res.json({ board, season: 1 });
});
app.get("/season", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const SUPPLY_WEI = 10n ** 27n; // 1B * 1e18
app.get("/holders/:token", (req, res) => {
  const t = (req.params.token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return res.status(400).json({ count: 0, top: [] });
  const bal = (stats.holders || {})[t] || {};
  const padA = PAD.toLowerCase(), dead = "0x000000000000000000000000000000000000dead";
  const dev = (stats.creatorOf || {})[t] || null;
  const entries = Object.entries(bal)
    .filter(([a, v]) => BigInt(v) > 0n && a !== padA && a !== dead)
    .map(([a, v]) => ({ a, pct: Number((BigInt(v) * 10000n) / SUPPLY_WEI) / 100, dev: a === dev }))
    .sort((x, y) => y.pct - x.pct);
  res.json({ count: entries.length, top: entries.slice(0, 10) });
});
