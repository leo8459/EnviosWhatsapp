// index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { executablePath } = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 8452;
const SESSION_FOLDER = process.env.SESSION_FOLDER || ".wwebjs_auth";

/* ───── DB mensajes ───── */
const db = new Database("./database/mensajes.db");
db.prepare(
  `CREATE TABLE IF NOT EXISTS mensajes(id INTEGER PRIMARY KEY AUTOINCREMENT, texto TEXT NOT NULL)`
).run();

/* ───── Cliente WhatsApp ───── */
let qrCodeData = null,
  isClientReady = false;
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_FOLDER }),
  puppeteer: {
    headless: true,
    executablePath: executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});
client.on("qr", async (qr) => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log("📲 QR listo");
});
client.on("ready", () => {
  isClientReady = true;
  console.log("✅ WhatsApp conectado");
});
client.initialize();

/* ───── Middlewares ───── */
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("views"));
app.use("/uploads", express.static("uploads"));

/* ───── Páginas ───── */
app.get("/bot", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "bot.html"))
);
app.get("/", (_req, res) => res.redirect("/bot"));

/* ───── QR / Health ───── */
app.get("/qr", (_req, res) => {
  if (qrCodeData && !isClientReady)
    return res.json({ status: "qr", src: qrCodeData });
  if (isClientReady) return res.json({ status: "connected" });
  return res.json({ status: "pending" });
});
app.get("/health", (_req, res) => res.json({ ready: isClientReady }));

/* ───── CRUD mensajes ───── */
app.post("/mensajes", (req, res) => {
  const texto = (req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ success: false });
  db.prepare("INSERT INTO mensajes(texto) VALUES(?)").run(texto);
  res.json({ success: true });
});
app.get("/mensajes", (_req, res) =>
  res.json(db.prepare("SELECT * FROM mensajes").all())
);
app.delete("/mensajes/:id", (req, res) => {
  db.prepare("DELETE FROM mensajes WHERE id=?").run(+req.params.id);
  res.json({ success: true });
});

/* ───── Proxy paquetes (sin CORS) ───── */
const API_TOKEN =
  "eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK";
app.get("/packages", async (_req, res) => {
  try {
    const r = await fetch("http://172.65.10.52/api/packagesRDD", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    if (!r.ok) throw new Error(r.status);
    res.json(await r.json());
  } catch (e) {
    console.error("proxy /packages", e);
    res.status(502).json({ ok: false });
  }
});

/* ───── send único ───── */
app.post("/send", async (req, res) => {
  const { to, message } = req.body || {};
  if (!/^\d{10,16}@c\.us$/.test(to || ""))
    return res.status(400).json({ success: false, error: "num" });
  if (!message?.trim())
    return res.status(400).json({ success: false, error: "msg" });
  if (!isClientReady)
    return res.status(503).json({ success: false, error: "wa" });
  try {
    if (!(await client.isRegisteredUser(to)))
      return res.json({ success: false, error: "noreg" });
    await client.sendMessage(to, message.trim());
    console.log(`✅ ${to} ← ${message}`);
    res.json({ success: true });
  } catch (e) {
    console.error("/send", e);
    res.status(500).json({ success: false });
  }
});

/* ───── Excel masivo (sin cambios) ───── */
const upload = multer({ dest: "uploads/" });
app.post("/enviar-excel", upload.single("excel"), async (req, res) => {
  try {
    const wb = xlsx.readFile(req.file.path);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const base = db
      .prepare("SELECT texto FROM mensajes")
      .all()
      .map((r) => r.texto)
      .filter(Boolean);
    if (!base.length)
      return res.json({ success: false, message: "No hay mensajes" });
    let bag = [...base];
    const pick = () => {
      if (!bag.length) bag = [...base];
      return bag.splice(Math.floor(Math.random() * bag.length), 1)[0];
    };
    const nums = rows
      .map((r) => r.TELEFONO?.toString().trim())
      .filter((t) => /^\d{7,15}$/.test(t || ""))
      .map((t) => `591${t}@c.us`);
    if (!nums.length)
      return res.json({ success: false, message: "Excel sin números" });
    console.log("🚀 envíos:", nums.length);
    let i = 0;
    const go = async () => {
      const n = nums[i];
      if (await client.isRegisteredUser(n)) {
        await client.sendMessage(n, pick());
        console.log("✅", n);
      }
      i++;
      if (i < nums.length)
        setTimeout(go, (Math.floor(Math.random() * 5) + 1) * 60000);
      else console.log("🏁 fin Excel");
    };
    go();
    fs.unlinkSync(req.file.path);
    res.json({ success: true });
  } catch (e) {
    console.error("Excel", e);
    res.json({ success: false });
  }
});

/* ───── logout ───── */
app.post("/logout", async (_req, res) => {
  try {
    await client.logout();
    if (fs.existsSync(SESSION_FOLDER))
      fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
    isClientReady = false;
    qrCodeData = null;
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

/* ───── start / graceful ───── */
const server = app.listen(PORT, () =>
  console.log(`🌐  http://localhost:${PORT}`)
);
process.on("SIGINT", async () => {
  console.log("\n⏻ cerrando…");
  try {
    await client.destroy();
  } catch {}
  server.close(() => process.exit(0));
});
process.on("unhandledRejection", (e) => console.error(e));
