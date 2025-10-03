// index.js — multi cuentas WA + mensajes por cuenta + Excel por cuenta (con 404 JSON)

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

// ====== 1) Config ======
const PORT = 8452;
// ↓↓↓ NUEVO BASE HTTPS:8100
const API_BASE = "https://172.65.10.51:8100";
const API_TOKEN =
  "eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK";

const HEADLESS = true;

const ACCOUNTS = {
  wa1: { sessionDir: ".wwebjs_auth_1", packagesPath: "/api/packagesRDD" },
  wa2: {
    sessionDir: ".wwebjs_auth_2",
    packagesPath: "/api/packagesUENCOMIENDAS",
  },
  wa3: {
    sessionDir: ".wwebjs_auth_3",
    packagesPath: "/api/packagesUENCOMIENDAS",
  },
  sc1: {
    sessionDir: ".wwebjs_sc_1",
    packagesPath: "/api/packagesUENCOMIENDAS",
  },
  urbano2: { sessionDir: ".wwebjs_urbano_2", packagesPath: "/api/packagesRDD" },
  urbano3: { sessionDir: ".wwebjs_urbano_3", packagesPath: "/api/packagesRDD" },
  urbano4: { sessionDir: ".wwebjs_urbano_4", packagesPath: "/api/packagesRDD" },
  urbano5: { sessionDir: ".wwebjs_urbano_5", packagesPath: "/api/packagesRDD" },
};

// ====== 2) DB (mensajes por cuenta) ======
fs.mkdirSync(path.join(__dirname, "database"), { recursive: true });
const db = new Database("./database/mensajes.db");

db.prepare(
  `
  CREATE TABLE IF NOT EXISTS mensajes(
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    texto   TEXT NOT NULL
  );
`
).run();

// migración: columna account
const cols = db.prepare(`PRAGMA table_info(mensajes);`).all();
const hasAccount = cols.some((c) => c.name === "account");
if (!hasAccount) {
  db.prepare(`ALTER TABLE mensajes ADD COLUMN account TEXT;`).run();
  db.prepare(
    `UPDATE mensajes SET account = 'wa1' WHERE account IS NULL;`
  ).run();
}
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_mensajes_account ON mensajes(account)`
).run();

// ====== 3) Estado ======
const clients = {};
let scheduledQueues = { wa1: [], wa2: [], wa3: [], sc1: [], urbano2: [],urbano3: [],urbano4: [],urbano5: [] };
let isSending = { wa1: false, wa2: false, wa3: false, sc1: false, urbano2: false,urbano3: false,urbano4: false,urbano5: false };

const SESSIONS_DIR = path.resolve(__dirname, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Detecta chromium (opcional)
function getChromiumPath() {
  const candidates = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const c of candidates)
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  console.warn(
    "⚠️ No se encontró chromium; Puppeteer usará su valor por defecto"
  );
  return undefined;
}
const CHROME_PATH = getChromiumPath();

// ====== 4) WhatsApp Clients ======
function initClient(id) {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSIONS_DIR, clientId: id }),
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html",
    },
    puppeteer: {
      headless: HEADLESS,
      executablePath: CHROME_PATH,
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
  });

  clients[id] = {
    client: c,
    qr: null,
    ready: false,
    state: "INIT",
    authed: false,
  };

  c.on("loading_screen", (p, m) => console.log(`[${id}] ⏳ ${p}% - ${m}`));
  c.on("qr", async (qr) => {
    try {
      clients[id].qr = await qrcode.toDataURL(qr);
      clients[id].ready = false;
      console.log(`📲 QR listo para ${id}`);
    } catch (e) {
      console.error(`[${id}] QR error:`, e.message);
    }
  });
  c.on("authenticated", () => {
    clients[id].authed = true;
    clients[id].qr = null;
    console.log(`🔐 [${id}] authenticated`);
  });
  c.on("ready", () => {
    clients[id].ready = true;
    clients[id].qr = null;
    clients[id].state = "CONNECTED";
    console.log(`✅ ${id} ready`);
  });
  c.on("change_state", (state) => {
    clients[id].state = state;
    clients[id].ready = state === "CONNECTED";
    if (clients[id].ready) clients[id].qr = null;
    console.log(`🔄 [${id}] state: ${state}`);
  });
  c.on("auth_failure", (m) => {
    clients[id].ready = false;
    clients[id].authed = false;
    clients[id].qr = null;
    console.error(`❌ [${id}] auth_failure:`, m);
  });
  c.on("disconnected", (reason) => {
    clients[id].ready = false;
    clients[id].state = "DISCONNECTED";
    console.warn(`⚠️ [${id}] desconectado: ${reason}`);
    setTimeout(() => {
      try {
        c.initialize();
      } catch (e) {
        console.error(`[${id}] reinit:`, e.message);
      }
    }, 5000);
  });

  setInterval(async () => {
    try {
      const st = await c.getState();
      clients[id].state = st || clients[id].state;
      clients[id].ready = st === "CONNECTED";
      if (clients[id].ready) clients[id].qr = null;
    } catch {}
  }, 5000);

  c.initialize().catch((e) => {
    console.error(`💥 [${id}] init falló:`, e.message);
    setTimeout(() => {
      try {
        c.initialize();
      } catch (e2) {
        console.error(`[${id}] 2º init falló:`, e2.message);
      }
    }, 5000);
  });
}
for (const id of Object.keys(ACCOUNTS)) initClient(id);

// ====== 5) Express/API ======
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("views"));
app.use("/uploads", express.static("uploads"));

function st(acc, res) {
  if (!clients[acc]) {
    res.status(404).json({ error: "Cuenta desconocida" });
    return null;
  }
  return clients[acc];
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- util paquetes
const https = require("https");
const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // SOLO pruebas. En prod, instala la CA.

async function fetchPackages(url) {
  // 1) Bearer
  let r = await fetch(url, {
    agent: url.startsWith("https://") ? httpsAgent : undefined,
    headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: "application/json" },
    redirect: "follow",
  });

  // 2) Si la API responde 401, reintenta con header `token`
  if (r.status === 401) {
    r = await fetch(url, {
      agent: url.startsWith("https://") ? httpsAgent : undefined,
      headers: { token: API_TOKEN, Accept: "application/json" },
      redirect: "follow",
    });
  }
  return r;
}


// ===== Rutas de cuenta
app.get("/:acc/qr", (req, res) => {
  const s = st(req.params.acc, res);
  if (!s) return;
  if (s.ready) return res.json({ status: "connected" });
  if (s.qr) return res.json({ status: "qr", src: s.qr });
  res.json({ status: "pending" });
});

app.get("/:acc/health", (req, res) => {
  const s = st(req.params.acc, res);
  if (!s) return;
  res.json({ ready: s.ready });
});

app.get("/:acc/state", (req, res) => {
  const s = st(req.params.acc, res);
  if (!s) return;
  res.json({ ready: s.ready, state: s.state, authed: s.authed, hasQR: !!s.qr });
});

app.get("/:acc/packages", async (req, res) => {
  const acc = req.params.acc;
  if (!ACCOUNTS[acc])
    return res.status(404).json({ ok: false, error: "account_not_found" });
  try {
    const url = `${API_BASE}${ACCOUNTS[acc].packagesPath}`;
    const r = await fetchPackages(url);
    const raw = await r.text();
    if (!r.ok)
      return res
        .status(r.status)
        .json({ ok: false, status: r.status, message: raw.slice(0, 200) });
    try {
      JSON.parse(raw);
    } catch {
      return res
        .status(502)
        .json({ ok: false, message: "Respuesta no JSON (API)" });
    }
    res.type("json").send(raw);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post("/:acc/send", async (req, res) => {
  const s = st(req.params.acc, res);
  if (!s) return;
  if (!s.ready)
    return res.status(503).json({ success: false, error: "wa_not_ready" });

  const { to, message } = req.body || {};
  if (!/^\d{10,16}@c\.us$/.test(to || ""))
    return res.status(400).json({ success: false, error: "bad_number" });
  if (!message?.trim())
    return res.status(400).json({ success: false, error: "empty_message" });

  try {
    if (!(await s.client.isRegisteredUser(to)))
      return res.json({ success: false, error: "not_registered" });
    await s.client.sendMessage(to, message.trim(), { sendSeen: false });
    res.json({ success: true });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, error: "send_failed", detail: e.message });
  }
});

app.post("/:acc/logout", async (req, res) => {
  const s = st(req.params.acc, res);
  if (!s) return;
  try {
    await s.client.logout();
    fs.rmSync(path.join(SESSIONS_DIR, `session-${req.params.acc}`), {
      recursive: true,
      force: true,
    });
    s.ready = false;
    s.qr = null;
    s.state = "LOGGED_OUT";
    s.authed = false;
    res.json({ success: true });
  } catch {
    res.json({ success: false });
  }
});

// ====== MENSAJES por cuenta ======
app.post("/:acc/mensajes", (req, res) => {
  const acc = (req.params.acc || "").toLowerCase();
  const texto = (req.body?.texto || "").trim();
  console.log("POST /mensajes", { acc, hasText: !!texto });
  if (!ACCOUNTS[acc])
    return res
      .status(404)
      .json({ success: false, error: "account_not_found", acc });
  if (!texto) return res.status(400).json({ success: false, error: "empty" });
  db.prepare("INSERT INTO mensajes(texto, account) VALUES(?, ?)").run(
    texto,
    acc
  );
  res.json({ success: true });
});

app.get("/:acc/mensajes", (req, res) => {
  const acc = (req.params.acc || "").toLowerCase();
  console.log("GET /mensajes", { acc });
  if (!ACCOUNTS[acc])
    return res
      .status(404)
      .json({ success: false, error: "account_not_found", acc });
  const rows = db
    .prepare(
      "SELECT id, texto FROM mensajes WHERE account = ? ORDER BY id DESC"
    )
    .all(acc);
  res.json(rows);
});

app.delete("/:acc/mensajes/:id", (req, res) => {
  const acc = (req.params.acc || "").toLowerCase();
  const id = +req.params.id;
  console.log("DELETE /mensajes", { acc, id });
  if (!ACCOUNTS[acc])
    return res
      .status(404)
      .json({ success: false, error: "account_not_found", acc });
  db.prepare("DELETE FROM mensajes WHERE id = ? AND account = ?").run(id, acc);
  res.json({ success: true });
});

// ====== Excel por cuenta ======
const upload = multer({ dest: "uploads/" });
app.post("/:acc/enviar-excel", upload.single("excel"), async (req, res) => {
  const acc = (req.params.acc || "").toLowerCase();
  if (!ACCOUNTS[acc])
    return res.json({ success: false, message: "account_not_found" });
  const s = clients[acc];
  if (!s?.ready) return res.json({ success: false, message: "wa no lista" });

  try {
    const wb = xlsx.readFile(req.file.path);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const base = db
      .prepare("SELECT texto FROM mensajes WHERE account = ? ORDER BY id DESC")
      .all(acc)
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

    console.log(`🚀 ${acc} envíos Excel:`, nums.length);
    let i = 0;
    const go = async () => {
      const n = nums[i];
      try {
        if (await s.client.isRegisteredUser(n)) {
          await s.client.sendMessage(n, pick(), { sendSeen: false });
          console.log("✅", acc, n);
        }
      } catch (e) {
        console.error("Excel send error:", acc, e.message);
      }
      i++;
      if (i < nums.length)
        setTimeout(go, (Math.floor(Math.random() * 5) + 1) * 60000);
      else console.log("🏁 fin Excel", acc);
    };
    go();
    try {
      fs.unlinkSync(req.file.path);
    } catch {}
    res.json({ success: true });
  } catch (e) {
    console.error("Excel", acc, e);
    try {
      fs.unlinkSync(req.file.path);
    } catch {}
    res.json({ success: false });
  }
});

// ====== Vistas ======
app.get("/wa1", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "bot-wa1.html"))
);
app.get("/wa2", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "bot-wa2.html"))
);
app.get("/wa3", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "bot-wa3.html"))
);
app.get("/sc1", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "sc1.html"))
);
app.get("/urbano2", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "urbano2.html"))
);
app.get("/urbano3", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "urbano3.html"))
);
app.get("/urbano4", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "urbano4.html"))
);
app.get("/urbano5", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "urbano5.html"))
);
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "views", "index.html"))
);

// ====== 404 JSON (evita HTML por defecto) ======
app.use((req, res) => {
  res
    .status(404)
    .json({
      ok: false,
      error: "route_not_found",
      method: req.method,
      url: req.originalUrl,
    });
});

// ====== Server ======
const server = app.listen(PORT, () =>
  console.log(`🌐  http://localhost:${PORT}`)
);

process.on("SIGINT", async () => {
  console.log("\n⏻ cerrando…");
  try {
    for (const { client } of Object.values(clients)) await client.destroy();
  } catch {}
  server.close(() => process.exit(0));
});
process.on("unhandledRejection", (e) => console.error(e));
