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
