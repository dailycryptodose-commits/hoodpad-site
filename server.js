const express = require("express");
const path = require("path");
const fs = require("fs");
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

app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "logo.png")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("hoodpad site running on " + port));

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

app.get("/prices/:token", (req, res) => {
  const t = (req.params.token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return res.status(400).json([]);
  res.json(prices[t] || []);
});

// token pages — same app, client-side routing
app.get("/t/:token", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---- analytics indexer ----
const STATS_FILE = path.join(DATA_DIR, "stats.json");
let stats = { lastBlock: 0, vol: "0", fees: "0", buys: 0, sells: 0, launches: 0, migrations: 0, traders: {}, daily: {}, perToken: {} };
try { stats = Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, "utf8"))); } catch (e) {}

const padIface = new ethers.Interface([
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol)",
  "event Buy(address indexed token, address indexed buyer, uint ethIn, uint tokensOut)",
  "event Sell(address indexed token, address indexed seller, uint tokensIn, uint ethOut, uint taxEth)",
  "event Migrated(address indexed token, uint ethToLp, uint tokensToLp)"
]);

function addWei(a, b) { return (BigInt(a) + b).toString(); }
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
        if (p.name === "TokenCreated") stats.launches++;
        if (p.name === "Migrated") stats.migrations++;
        if (p.name === "Buy") {
          stats.buys++;
          stats.vol = addWei(stats.vol, p.args.ethIn);
          stats.fees = addWei(stats.fees, p.args.ethIn / 100n);
          stats.daily[day] = addWei(stats.daily[day] || "0", p.args.ethIn);
          if (Object.keys(stats.traders).length < 100000) stats.traders[p.args.buyer.toLowerCase()] = 1;
          bump(p.args.token, p.args.ethIn);
        }
        if (p.name === "Sell") {
          stats.sells++;
          stats.vol = addWei(stats.vol, p.args.ethOut);
          stats.fees = addWei(stats.fees, p.args.taxEth);
          stats.daily[day] = addWei(stats.daily[day] || "0", p.args.ethOut);
          if (Object.keys(stats.traders).length < 100000) stats.traders[p.args.seller.toLowerCase()] = 1;
          bump(p.args.token, p.args.ethOut);
        }
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
  res.json({
    vol: stats.vol, buys: stats.buys, sells: stats.sells,
    launches: stats.launches, migrations: stats.migrations,
    traders: Object.keys(stats.traders).length,
    daily: stats.daily, perToken: stats.perToken,
  });
});

app.get("/analytics", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
