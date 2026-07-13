const express = require("express");
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");

const app = express();
app.use(express.json({ limit: "50kb" }));

const PAD = process.env.PAD_ADDRESS;
if (!PAD) console.log("⚠️  PAD_ADDRESS env var not set — site won't load tokens");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC);
const pad = PAD ? new ethers.Contract(PAD, [
  "function curves(address) view returns (uint ethReserve, uint tokReserve, uint realEth, address creator, bool migrated)"
], provider) : null;

// metadata store — uses railway volume at /data if present, else local file
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const META_FILE = path.join(DATA_DIR, "meta.json");
let meta = {};
try { meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch (e) {}
const saveMeta = () => fs.writeFileSync(META_FILE, JSON.stringify(meta));

const clean = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const okUrl = (s) => !s || /^https?:\/\/[^\s]+$/i.test(s);

app.get("/config", (req, res) => res.json({ pad: PAD || "" }));
app.get("/meta", (req, res) => res.json(meta));

// set token metadata — only the on-chain creator can, proven by wallet signature
app.post("/meta", async (req, res) => {
  try {
    const { token, image, telegram, x, website, sig } = req.body || {};
    if (!ethers.isAddress(token)) return res.status(400).json({ error: "bad token" });
    const m = {
      image: clean(image, 500), telegram: clean(telegram, 200),
      x: clean(x, 200), website: clean(website, 200),
    };
    if (![m.image, m.telegram, m.x, m.website].every(okUrl))
      return res.status(400).json({ error: "links must start with http" });

    const message = "hoodpad-meta:" + token.toLowerCase();
    const signer = ethers.verifyMessage(message, sig);
    const curve = await pad.curves(token);
    if (signer.toLowerCase() !== curve.creator.toLowerCase())
      return res.status(403).json({ error: "only the token creator can edit" });

    meta[token.toLowerCase()] = m;
    saveMeta();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: "verification failed" }); }
});

app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "logo.png")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("hoodpad site running on " + port));
