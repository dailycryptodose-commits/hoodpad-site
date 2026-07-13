const express = require("express");
const path = require("path");
const app = express();

const PAD = process.env.PAD_ADDRESS;
if (!PAD) console.log("⚠️  PAD_ADDRESS env var not set — site won't load tokens");

app.get("/config", (req, res) => res.json({ pad: PAD || "" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("hoodpad site running on " + port));
