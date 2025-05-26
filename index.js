const express      = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode       = require('qrcode');
const multer       = require('multer');
const xlsx         = require('xlsx');
const fs           = require('fs');
const Database     = require('better-sqlite3');
const { executablePath } = require('puppeteer');

const app  = express();
const port = 3000;

/* ──────── 1. Base de datos ──────── */
const db = new Database('./database/mensajes.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS mensajes (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    texto TEXT NOT NULL
  )
`).run();

/* ──────── 2. Cliente WhatsApp ──────── */
let qrCodeData = null;
let isClientReady = false;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: executablePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async qr => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('📲  QR generado');
});
client.on('ready', () => {
  isClientReady = true;
  console.log('✅  WhatsApp conectado');
});
client.initialize();

/* ──────── 3. Middleware ──────── */
app.use(express.static('views'));
app.use('/uploads', express.static('uploads'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ──────── 4. Endpoints utilitarios ──────── */
app.get('/qr', (req, res) => {
  if (qrCodeData && !isClientReady) res.send({ status: 'qr', src: qrCodeData });
  else if (isClientReady)          res.send({ status: 'connected' });
  else                              res.send({ status: 'pending' });
});

app.post('/mensajes', (req, res) => {
  const texto = (req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ success:false });
  db.prepare('INSERT INTO mensajes(texto) VALUES(?)').run(texto);
  res.json({ success:true });
});

app.get('/mensajes', (_req,res) => {
  const mensajes = db.prepare('SELECT * FROM mensajes').all();
  res.json(mensajes);
});

app.delete('/mensajes/:id', (req,res)=>{
  db.prepare('DELETE FROM mensajes WHERE id=?').run(+req.params.id);
  res.json({success:true});
});

/* ──────── 5. Carga Excel + envíos escalonados ──────── */
const upload = multer({ dest:'uploads/' });

app.post('/enviar-excel', upload.single('excel'), async (req, res) => {
  try {
    /* 5.1  Leer Excel */
    const wb     = xlsx.readFile(req.file.path);
    const sheet  = wb.Sheets[wb.SheetNames[0]];
    const rows   = xlsx.utils.sheet_to_json(sheet);

    /* 5.2  Leer mensajes de la BD y preparar bolsa sin repeticiones */
    const baseMensajes = db.prepare('SELECT texto FROM mensajes').all()
                            .map(r => r.texto).filter(Boolean);
    if (!baseMensajes.length)
      return res.json({ success:false, message:'No hay mensajes en la BD' });

    let bolsa = [...baseMensajes];                      // se vaciará antes de repetir
    const nextMensaje = () => {
      if (!bolsa.length) bolsa = [...baseMensajes];     // re-iniciar bolsa
      const idx = Math.floor(Math.random()*bolsa.length);
      return bolsa.splice(idx,1)[0];
    };

    /* 5.3  Extraer y limpiar números */
    const numeros = rows
       .map(r => r.TELEFONO?.toString().trim())
       .filter(t => t && /^\d{7,15}$/.test(t))
       .map(t => `591${t}@c.us`);

    if (!numeros.length)
      return res.json({ success:false, message:'Excel sin números válidos' });

    console.log(`🚀  Programados ${numeros.length} envíos (1–5 min aleatorio)`);

    /* 5.4  Función recursiva con retardo aleatorio */
    let i = 0;
    const enviar = async () => {
      const numero = numeros[i];
      const ok     = await client.isRegisteredUser(numero);

      if (ok) {
        const msg = nextMensaje();
        await client.sendMessage(numero, msg);
        console.log(`✅  ${numero}  ←  ${msg}`);
      } else {
        console.log(`❌  Número no registrado: ${numero}`);
      }

      i++;
      if (i < numeros.length) {
        const delay = (Math.floor(Math.random()*5)+1) * 60_000; // 1–5 min
        console.log(`⏳  Próximo en ${(delay/60000).toFixed(1)} min`);
        setTimeout(enviar, delay);
      } else {
        console.log('🏁  Todos los envíos finalizados');
      }
    };
    enviar();                       // empieza de inmediato

    fs.unlinkSync(req.file.path);   // limpia el Excel subido
    res.json({ success:true, message:'Envíos programados' });

  } catch (err) {
    console.error('⚠️  Error procesando Excel', err);
    res.json({ success:false });
  }
});

/* ──────── 6. Arrancar servidor ──────── */
app.listen(port, ()=> console.log(`🌐  http://localhost:${port}`));
