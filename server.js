const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { WebSocketServer } = require("ws");
const { ethers } = require("ethers");

const app = express();
app.use(express.json({ limit: "4mb" })); // room for base64 logo uploads

const PAD = process.env.PAD_ADDRESS;
if (!PAD) console.log("⚠️  PAD_ADDRESS env var not set — site won't load tokens");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC);
const pad = PAD ? new ethers.Contract(PAD, [
  "function curves(address) view returns (uint ethReserve, uint tokReserve, uint realEth, address creator, bool migrated)"
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

app.get("/config", (req, res) => res.json({ pad: PAD || "" }));
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
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---- realtime: websocket push of trades & launches (~2.5s from chain) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
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
app.get("/t/:token", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

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

app.get("/analytics", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// season 1 points: 1000 pts per ETH traded + 500 per token launched
app.get("/points", (req, res) => {
  const pts = {};
  for (const [a, wei] of Object.entries(stats.traderVol || {})) {
    pts[a] = (pts[a] || 0) + Number(BigInt(wei) / 1000000000000000n) / 1000; // eth with 3dp
  }
  for (const a of Object.keys(pts)) pts[a] = Math.floor(pts[a] * 1000);
  for (const [a, n] of Object.entries(stats.creatorLaunches || {})) {
    pts[a] = (pts[a] || 0) + n * 500;
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
