// index.js  – dos cuentas WA + doble endpoint de paquetes + manejo 401
require('dotenv').config();

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
const { executablePath } = require('puppeteer');
const cron = require('node-cron');
const moment = require('moment-timezone');

const PORT = process.env.PORT || 8452;

/* ═════════ 1. CONFIGURACIÓN ═════════ */
const API_BASE  = 'http://172.65.10.52';
const API_TOKEN = 'eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK';

const ACCOUNTS = {
  wa1: {
    sessionDir   : '.wwebjs_auth_1',
    packagesPath : '/api/packagesRDD',
  },
  wa2: {
    sessionDir   : '.wwebjs_auth_2',
    packagesPath : '/api/packagesUENCOMIENDAS',
  },
  wa3: {
    sessionDir   : '.wwebjs_auth_3',
    packagesPath : '/api/packagesUENCOMIENDAS',
  },
  sc1: {
    sessionDir   : '.wwebjs_sc_1',
    packagesPath : '/api/packagesUENCOMIENDAS',
  },
};

/* ═════════ 2. BASE DE DATOS ═════════ */
const db = new Database('./database/mensajes.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS mensajes(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    texto TEXT NOT NULL
  );
`).run();

/* ═════════ 3. CLIENTES WHATSAPP ═════════ */
const clients = {}; 

for (const id of Object.keys(ACCOUNTS)) {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: ACCOUNTS[id].sessionDir }),
    puppeteer: {
      headless: true,
      executablePath: executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  clients[id] = { client: c, qr: null, ready: false };

  c.on('qr', async qr => {
    clients[id].qr = await qrcode.toDataURL(qr);
    console.log(`📲 QR listo para ${id}`);
  });
  c.on('ready', () => {
    clients[id].ready = true;
    console.log(`✅ ${id} conectado`);
  });

  c.initialize();
}

/* ═════════ 4. APP EXPRESS ═════════ */
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('views'));
app.use('/uploads', express.static('uploads'));

/* helper */
function st(acc, res) {
  if (!clients[acc]) { res.status(404).json({ error:'Cuenta desconocida' }); return null; }
  return clients[acc];
}
/* ═════ ENVÍO PROGRAMADO DIARIO ═════ */
let scheduledQueues = {
  wa1: [],
  wa2: [],
  wa3: [],
    sc1: [],

};
let isSending = {
  wa1: false,
  wa2: false,
  wa3: false,
    sc1: false,

};


function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function cargarNumerosDesdeAPI(accountId) {
  try {
    const url = `${API_BASE}${ACCOUNTS[accountId].packagesPath}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Respuesta no es un array');

    // Orden descendente
    const listaOrdenada = [...data].reverse();

    scheduledQueues[accountId] = listaOrdenada
      .map(r => r.TELEFONO?.toString().trim())
      .filter(t => /^\d{7,15}$/.test(t))
      .map(t => `591${t}@c.us`);

    console.log(`📦 ${accountId}: ${scheduledQueues[accountId].length} números cargados`);

  } catch (e) {
    console.error(`❌ ${accountId}: error al cargar API –`, e.message);
    scheduledQueues[accountId] = [];
  }
}


async function startScheduledSending(accountId) {
  const clientObj = clients[accountId];
  if (!clientObj || !clientObj.ready) return console.log(`⚠️ ${accountId} no está listo`);

  const mensajes = db.prepare('SELECT texto FROM mensajes ORDER BY id DESC').all().map(r => r.texto).filter(Boolean);
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
        console.log(`✅ [${accountId}] Mensaje ${i + 1} enviado a ${number} – "${msg}"`);
      } else {
        console.log(`⛔ [${accountId}] No registrado: ${number}`);
      }
    } catch (err) {
      console.error(`❌ [${accountId}] Error al enviar a ${number}:`, err.message);
    }
    const baseWait = 180000;
    const extra = Math.floor(Math.random() * 120000);
    await wait(baseWait + extra);
  }

  isSending[accountId] = false;
  scheduledQueues[accountId] = [];
  console.log(`🏁 ${accountId} envío terminado.`);
}


/* ═════ 4A. ENDPOINTS POR CUENTA ═════ */

/* QR & health */
app.get('/:acc/qr', (req,res)=>{
  const s = st(req.params.acc,res); if(!s) return;
  if(s.ready)   return res.json({status:'connected'});
  if(s.qr)      return res.json({status:'qr',src:s.qr});
  res.json({status:'pending'});
});
app.get('/:acc/health', (req,res)=>{
  const s=st(req.params.acc,res); if(!s) return;
  res.json({ready:s.ready});
});

/* -------- PAQUETES (gestiona 401) -------- */
async function fetchPackages(url){
  /* 1º intento: Authorization: Bearer */
  let r = await fetch(url,{
          headers:{ Authorization:`Bearer ${API_TOKEN}`, Accept:'application/json' }});
  if(r.status!==401) return r;                 // ok o error ≠401 → devolvemos

  /* 2º intento: cabecera 'token' simple */
  return fetch(url,{ headers:{ token:API_TOKEN, Accept:'application/json' }});
}

app.get('/:acc/packages', async (req,res)=>{
  const acc=req.params.acc;
  if(!ACCOUNTS[acc]) return res.status(404).json({error:'Cuenta desconocida'});

  try{
    const url=`${API_BASE}${ACCOUNTS[acc].packagesPath}`;
    const r   = await fetchPackages(url);
    const raw = await r.text();

    if(!r.ok){
      console.error('/packages', acc, r.status, raw.slice(0,200));
      return res.status(r.status).json({ ok:false, status:r.status, message:raw.slice(0,200) });
    }
    res.type('json').send(raw);                // éxito
  }catch(e){
    console.error('/packages', acc, e.message);
    res.status(502).json({ ok:false, error:e.message });
  }
});

/* Enviar mensaje único */
app.post('/:acc/send', async (req,res)=>{
  const s=st(req.params.acc,res); if(!s) return;
  if(!s.ready) return res.status(503).json({success:false,error:'wa'});

  const {to,message}=req.body||{};
  if(!/^\d{10,16}@c\.us$/.test(to||''))   return res.status(400).json({success:false,error:'num'});
  if(!message?.trim())                    return res.status(400).json({success:false,error:'msg'});

  try{
    if(!(await s.client.isRegisteredUser(to))) return res.json({success:false,error:'noreg'});
    await s.client.sendMessage(to,message.trim());
    console.log(`✅ [${req.params.acc}] ${to} ← ${message}`);
    res.json({success:true});
  }catch(e){
    console.error('/send',req.params.acc,e);
    res.status(500).json({success:false});
  }
});

/* Logout */
app.post('/:acc/logout', async (req,res)=>{
  const s=st(req.params.acc,res); if(!s) return;
  try{
    await s.client.logout();
    fs.rmSync(ACCOUNTS[req.params.acc].sessionDir,{recursive:true,force:true});
    s.ready=false; s.qr=null;
    res.json({success:true});
  }catch{ res.json({success:false}); }
});

/* ═════ 4B. ENDPOINTS COMUNES ═════ */

/* CRUD mensajes */
app.post('/:acc/prelista', async (req, res) => {
  const acc = req.params.acc;
  if (!ACCOUNTS[acc]) return res.status(404).json({ ok:false, error:'Cuenta desconocida' });

  // admite "numeros" o "numeros[]"
  let nums = req.body.numeros || req.body['numeros[]'] || [];
  if (!Array.isArray(nums)) nums = [nums];      // por si viene un solo string

  nums = nums.filter(n => /^\d{10,16}@c\.us$/.test(n));

  if (!nums.length) return res.status(400).json({ ok:false, error:'Lista vacía' });

  scheduledQueues[acc] = nums;
  console.log(`📋 Recibida prelista (${nums.length}) para ${acc}`);

  if (clients[acc]?.ready && !isSending[acc]) startScheduledSending(acc);

  res.json({ ok:true, total:nums.length });
});


app.post('/mensajes',(req,res)=>{
  const texto=(req.body?.texto||'').trim();
  if(!texto) return res.status(400).json({success:false});
  db.prepare('INSERT INTO mensajes(texto) VALUES(?)').run(texto);
  res.json({success:true});
});
app.get('/mensajes',(_req,res)=>
  res.json(db.prepare('SELECT * FROM mensajes').all())
);
app.delete('/mensajes/:id',(req,res)=>{
  db.prepare('DELETE FROM mensajes WHERE id=?').run(+req.params.id);
  res.json({success:true});
});

/* Excel → usa wa1 por defecto */
const upload=multer({dest:'uploads/'});
app.post('/enviar-excel',upload.single('excel'),async(req,res)=>{
  const s=clients.wa1;
  if(!s.ready) return res.json({success:false,message:'wa no lista'});

  try{
    const wb   = xlsx.readFile(req.file.path);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const base = db.prepare('SELECT texto FROM mensajes').all()
                   .map(r=>r.texto).filter(Boolean);
    if(!base.length) return res.json({success:false,message:'No hay mensajes'});

    let bag=[...base];
    const pick=()=>{ if(!bag.length) bag=[...base];
                     return bag.splice(Math.floor(Math.random()*bag.length),1)[0]; };

    const nums=rows.map(r=>r.TELEFONO?.toString().trim())
                   .filter(t=>/^\d{7,15}$/.test(t||''))
                   .map(t=>`591${t}@c.us`);
    if(!nums.length) return res.json({success:false,message:'Excel sin números'});

    console.log('🚀 envíos:',nums.length);
    let i=0;
    const go=async()=>{
      const n=nums[i];
      if(await s.client.isRegisteredUser(n)){
        await s.client.sendMessage(n,pick());
        console.log('✅',n);
      }
      i++;
      if(i<nums.length) setTimeout(go,(Math.floor(Math.random()*5)+1)*60000);
      else console.log('🏁 fin Excel');
    };
    go();
    fs.unlinkSync(req.file.path);
    res.json({success:true});
  }catch(e){
    console.error('Excel',e);
    res.json({success:false});
  }
});


// cron.schedule('* * * * *', async () => {
//   const now = moment().tz('America/La_Paz');
//   const hour = now.hour();
//   const minute = now.minute();

//   if ((hour > 23 || (hour === 15 && minute >= 27)) && hour < 17) {
//     for (const acc of Object.keys(ACCOUNTS)) {
//       if (!isSending[acc]) {
//         await cargarNumerosDesdeAPI(acc);
//         if (scheduledQueues[acc].length > 0) {
//           console.log(`🕒 ${acc}: iniciando envío ${hour}:${minute < 10 ? '0'+minute : minute}`);
//           startScheduledSending(acc);
//         } else {
//           console.log(`ℹ️ ${acc}: sin números para enviar`);
//         }
//       }
//     }
//   }
// });



/* ═════════ 5. VISTAS ═════════ */
app.get('/wa1',(_req,res)=>res.sendFile(path.join(__dirname,'views','bot-wa1.html')));
app.get('/wa2',(_req,res)=>res.sendFile(path.join(__dirname,'views','bot-wa2.html')));
app.get('/wa3',(_req,res)=>res.sendFile(path.join(__dirname,'views','bot-wa3.html')));
app.get('/sc1',(_req,res)=>res.sendFile(path.join(__dirname,'views','sc1.html')));
app.get('/',(_req,res)=>res.sendFile(path.join(__dirname,'views','index.html')));

/* ═════════ 6. SERVER ═════════ */
const server=app.listen(PORT,()=>console.log(`🌐  http://localhost:${PORT}`));
process.on('SIGINT',async()=>{
  console.log('\n⏻ cerrando…');
  try{ for(const {client} of Object.values(clients)) await client.destroy(); }catch{}
  server.close(()=>process.exit(0));
});
process.on('unhandledRejection',e=>console.error(e));
