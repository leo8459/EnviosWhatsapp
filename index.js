// index.js — multi cuentas WA + QR en vistas + estado confiable + envíos robustos

// ====== Dependencias ======
const express    = require('express');
const cors       = require('cors');
const fetch      = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode     = require('qrcode');
const multer     = require('multer');
const xlsx       = require('xlsx');
const fs         = require('fs');
const path       = require('path');
const Database   = require('better-sqlite3');
// const moment  = require('moment-timezone'); // úsalo si lo necesitas

// ====== 1) Config embebida (sin .env) ======
const PORT      = 8452;

// ⚠️ Asegúrate del puerto correcto de tu API (ej: 8000 en Laravel)
const API_BASE  = 'http://172.65.10.52:8000';
const API_TOKEN = 'eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK';

// Headless = true para que NO abra ventana; el QR sale solo en tus vistas
const HEADLESS  = true;

const ACCOUNTS = {
  wa1: { sessionDir: '.wwebjs_auth_1', packagesPath: '/api/packagesRDD' },
  wa2: { sessionDir: '.wwebjs_auth_2', packagesPath: '/api/packagesUENCOMIENDAS' },
  wa3: { sessionDir: '.wwebjs_auth_3', packagesPath: '/api/packagesUENCOMIENDAS' },
  sc1: { sessionDir: '.wwebjs_sc_1',  packagesPath: '/api/packagesUENCOMIENDAS' },
};

// ====== 2) DB mínima para mensajes ======
fs.mkdirSync(path.join(__dirname, 'database'), { recursive: true });
const db = new Database('./database/mensajes.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS mensajes(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    texto TEXT NOT NULL
  );
`).run();

// ====== 3) Estado global ======
const clients = {};
let scheduledQueues = { wa1: [], wa2: [], wa3: [], sc1: [] };
let isSending       = { wa1: false, wa2: false, wa3: false, sc1: false };

// Detecta la ruta de Chromium en Debian
function getChromiumPath() {
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  console.warn('⚠️ No se encontró /usr/bin/chromium ni chromium-browser; Puppeteer intentará su valor por defecto');
  return undefined;
}
const CHROME_PATH = getChromiumPath();

// ====== 4) Clientes WhatsApp ======
function initClient(id) {
  const c = new Client({
    authStrategy: new LocalAuth({
      dataPath: ACCOUNTS[id].sessionDir,
      clientId: id, // importante para que no se mezclen
    }),
    puppeteer: {
      headless: HEADLESS,
      executablePath: CHROME_PATH,   // ✅ Debian lo necesita (si existe)
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
    },
  });

  clients[id] = { client: c, qr: null, ready: false, state: 'INIT', authed: false };

  // Eventos
  c.on('qr', async (qr) => {
    try {
      clients[id].qr = await qrcode.toDataURL(qr);
      clients[id].ready = false;
      console.log(`📲 QR listo para ${id}`);
    } catch (e) {
      console.error(`[${id}] Error generando QR:`, e.message);
    }
  });

  c.on('authenticated', () => {
    clients[id].authed = true;
    clients[id].qr = null;
    console.log(`🔐 [${id}] authenticated`);
  });

  c.on('ready', () => {
    clients[id].ready = true;
    clients[id].qr = null;
    clients[id].state = 'CONNECTED';
    console.log(`✅ ${id} conectado (ready)`);
  });

  c.on('change_state', (state) => {
    clients[id].state = state;
    clients[id].ready = state === 'CONNECTED';
    if (clients[id].ready) clients[id].qr = null;
    console.log(`🔄 [${id}] state: ${state}`);
  });

  c.on('auth_failure', (m) => {
    clients[id].ready = false;
    clients[id].authed = false;
    clients[id].qr = null;
    console.error(`❌ [${id}] auth_failure:`, m);
  });

  c.on('disconnected', (reason) => {
    clients[id].ready = false;
    clients[id].state = 'DISCONNECTED';
    console.warn(`⚠️ [${id}] desconectado: ${reason}`);
    setTimeout(() => {
      try { c.initialize(); } catch (e) { console.error(`[${id}] reinit error:`, e.message); }
    }, 5000);
  });

  // Watchdog
  setInterval(async () => {
    try {
      const st = await c.getState(); // CONNECTED | OPENING | PAIRING | TIMEOUT | CONFLICT | UNLAUNCHED
      clients[id].state = st || clients[id].state;
      clients[id].ready = st === 'CONNECTED';
      if (clients[id].ready) clients[id].qr = null;
    } catch (_) {}
  }, 5000);

  c.initialize().catch(e => {
    console.error(`💥 [${id}] initialize() falló:`, e.message);
    setTimeout(() => {
      try { c.initialize(); } catch (e2) { console.error(`[${id}] 2º init falló:`, e2.message); }
    }, 5000);
  });
}
for (const id of Object.keys(ACCOUNTS)) initClient(id);

// ====== 5) Express/API ======
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('views'));               // sirve tus HTML
app.use('/uploads', express.static('uploads')); // subidas

function st(acc, res) {
  if (!clients[acc]) { res.status(404).json({ error: 'Cuenta desconocida' }); return null; }
  return clients[acc];
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// --- Carga de teléfonos desde API (por si lo usas)
async function cargarNumerosDesdeAPI(accountId) {
  try {
    const url = `${API_BASE}${ACCOUNTS[accountId].packagesPath}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Respuesta no es un array');

    const lista = [...data].reverse()
      .map(r => r.TELEFONO?.toString().trim())
      .filter(t => /^\d{7,15}$/.test(t))
      .map(t => `591${t}@c.us`);

    scheduledQueues[accountId] = lista;
    console.log(`📦 ${accountId}: ${lista.length} números cargados`);
  } catch (e) {
    console.error(`❌ ${accountId}: error al cargar API –`, e.message);
    scheduledQueues[accountId] = [];
  }
}

// --- Envío programado (si lo usas)
async function startScheduledSending(accountId) {
  const clientObj = clients[accountId];
  if (!clientObj || !clientObj.ready) return console.log(`⚠️ ${accountId} no está listo`);

  const mensajes = db.prepare('SELECT texto FROM mensajes ORDER BY id DESC').all()
                     .map(r => r.texto).filter(Boolean);
  if (!mensajes.length) return console.log(`⚠️ ${accountId} sin mensajes`);

  const lista = [...scheduledQueues[accountId]];
  if (!lista.length) return console.log(`⚠️ ${accountId} lista vacía`);

  console.log(`🚀 Iniciando envío para ${accountId} (${lista.length} números)`);
  let bag = [...mensajes];
  const pick = () => { if (!bag.length) bag = [...mensajes]; return bag.splice(Math.floor(Math.random() * bag.length), 1)[0]; };

  isSending[accountId] = true;
  for (let i = 0; i < lista.length; i++) {
    const number = lista[i];
    const msg = pick();
    try {
      if (await clientObj.client.isRegisteredUser(number)) {
        await clientObj.client.sendMessage(number, msg);
        console.log(`✅ [${accountId}] ${i + 1}/${lista.length} → ${number}`);
      } else {
        console.log(`⛔ [${accountId}] No registrado: ${number}`);
      }
    } catch (err) {
      console.error(`❌ [${accountId}] Error al enviar a ${number}:`, err.message);
    }
    const baseWait = 180000; // 3 min
    const extra    = Math.floor(Math.random() * 120000); // + hasta 2 min
    await wait(baseWait + extra);
  }
  isSending[accountId] = false;
  scheduledQueues[accountId] = [];
  console.log(`🏁 ${accountId} envío terminado.`);
}

// ===== 5A) Endpoints por cuenta (QR/health/state/paquetes/send/logout) =====

// QR para tus vistas (polling cada 2s desde el front)
app.get('/:acc/qr', (req, res) => {
  const s = st(req.params.acc, res); if (!s) return;
  if (s.ready)   return res.json({ status: 'connected' });
  if (s.qr)      return res.json({ status: 'qr', src: s.qr });
  res.json({ status: 'pending' });
});

// Health (simple)
app.get('/:acc/health', (req, res) => {
  const s = st(req.params.acc, res); if (!s) return;
  res.json({ ready: s.ready });
});

// Estado detallado (útil para depurar)
app.get('/:acc/state', (req, res) => {
  const s = st(req.params.acc, res); if (!s) return;
  res.json({ ready: s.ready, state: s.state, authed: s.authed, hasQR: !!s.qr });
});

// Paquetes con manejo de 401 y protección anti-HTML
async function fetchPackages(url) {
  let r = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' } });
  if (r.status !== 401) return r;
  return fetch(url, { headers: { token: API_TOKEN, Accept: 'application/json' } });
}

app.get('/:acc/packages', async (req, res) => {
  const acc = req.params.acc;
  if (!ACCOUNTS[acc]) return res.status(404).json({ error: 'Cuenta desconocida' });

  try {
    const url = `${API_BASE}${ACCOUNTS[acc].packagesPath}`;
    const r   = await fetchPackages(url);
    const raw = await r.text();

    if (!r.ok) {
      console.error('/packages', acc, r.status, raw.slice(0, 200));
      return res.status(r.status).json({ ok: false, status: r.status, message: raw.slice(0, 200) });
    }
    try { JSON.parse(raw); }
    catch {
      console.error(`/packages ${acc}: respuesta no JSON. Revisa API_BASE/puerto/ruta.`);
      return res.status(502).json({ ok: false, message: 'Respuesta no JSON (¿URL/puerto/ruta incorrecta?)' });
    }
    res.type('json').send(raw);
  } catch (e) {
    console.error('/packages', acc, e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Envío individual
app.post('/:acc/send', async (req, res) => {
  const s = st(req.params.acc, res); if (!s) return;
  if (!s.ready) return res.status(503).json({ success: false, error: 'wa_not_ready' });

  const { to, message } = req.body || {};
  if (!/^\d{10,16}@c\.us$/.test(to || '')) return res.status(400).json({ success: false, error: 'bad_number' });
  if (!message?.trim()) return res.status(400).json({ success: false, error: 'empty_message' });

  try {
    if (!(await s.client.isRegisteredUser(to))) return res.json({ success: false, error: 'not_registered' });
    await s.client.sendMessage(to, message.trim());
    console.log(`✅ [${req.params.acc}] ${to}`);
    res.json({ success: true });
  } catch (e) {
    console.error('/send', req.params.acc, e);
    res.status(500).json({ success: false, error: 'send_failed' });
  }
});

// Logout + borrar sesión (para forzar nuevo QR)
app.post('/:acc/logout', async (req, res) => {
  const s = st(req.params.acc, res); if (!s) return;
  try {
    await s.client.logout();
    fs.rmSync(ACCOUNTS[req.params.acc].sessionDir, { recursive: true, force: true });
    s.ready = false; s.qr = null; s.state = 'LOGGED_OUT'; s.authed = false;
    res.json({ success: true });
  } catch {
    res.json({ success: false });
  }
});

// ===== 5B) Endpoints comunes (mensajes + Excel) =====
app.post('/mensajes', (req, res) => {
  const texto = (req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ success: false });
  db.prepare('INSERT INTO mensajes(texto) VALUES(?)').run(texto);
  res.json({ success: true });
});
app.get('/mensajes', (_req, res) => {
  res.json(db.prepare('SELECT * FROM mensajes').all());
});
app.delete('/mensajes/:id', (req, res) => {
  db.prepare('DELETE FROM mensajes WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

const upload = multer({ dest: 'uploads/' });
app.post('/enviar-excel', upload.single('excel'), async (req, res) => {
  const s = clients.wa1;
  if (!s?.ready) return res.json({ success: false, message: 'wa no lista' });

  try {
    const wb   = xlsx.readFile(req.file.path);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const base = db.prepare('SELECT texto FROM mensajes').all().map(r => r.texto).filter(Boolean);
    if (!base.length) return res.json({ success: false, message: 'No hay mensajes' });

    let bag = [...base];
    const pick = () => { if (!bag.length) bag = [...base]; return bag.splice(Math.floor(Math.random() * bag.length), 1)[0]; };

    const nums = rows.map(r => r.TELEFONO?.toString().trim())
      .filter(t => /^\d{7,15}$/.test(t || ''))
      .map(t => `591${t}@c.us`);
    if (!nums.length) return res.json({ success: false, message: 'Excel sin números' });

    console.log('🚀 envíos:', nums.length);
    let i = 0;
    const go = async () => {
      const n = nums[i];
      try {
        if (await s.client.isRegisteredUser(n)) {
          await s.client.sendMessage(n, pick());
          console.log('✅', n);
        }
      } catch (e) { console.error('Excel send error:', e.message); }
      i++;
      if (i < nums.length) setTimeout(go, (Math.floor(Math.random() * 5) + 1) * 60000);
      else console.log('🏁 fin Excel');
    };
    go();
    fs.unlinkSync(req.file.path);
    res.json({ success: true });
  } catch (e) {
    console.error('Excel', e);
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ success: false });
  }
});

// ====== 6) Vistas (usa tus HTML por cuenta) ======
app.get('/wa1', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'bot-wa1.html')));
app.get('/wa2', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'bot-wa2.html')));
app.get('/wa3', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'bot-wa3.html')));
app.get('/sc1', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'sc1.html')));
app.get('/',   (_req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));

// ====== 7) Server & señales ======
const server = app.listen(PORT, () => console.log(`🌐  http://localhost:${PORT}`));

process.on('SIGINT', async () => {
  console.log('\n⏻ cerrando…');
  try { for (const { client } of Object.values(clients)) await client.destroy(); } catch {}
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', e => console.error(e));
