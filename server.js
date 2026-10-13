const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Carga .env si existe (Node >= 20.12). Si no, se usan los valores por defecto.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // sin archivo .env: normal
}

// ---------------------------------------------------------------------------
// Configuración (variables de entorno)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'barbero123';
const DEV_PASSWORD = process.env.DEV_PASSWORD || '0526';
const OPENWA_URL = (process.env.OPENWA_URL || '').trim();
const OPENWA_API_KEY = (process.env.OPENWA_API_KEY || '').trim();
const OPENWA_SESSION = (process.env.OPENWA_SESSION || 'barberia').trim();
const SHOP_NAME = process.env.SHOP_NAME || 'Mi Barbería';
const SHOP_WHATSAPP = (process.env.SHOP_WHATSAPP || '').replace(/[^0-9]/g, '');
const HORA_INICIO = process.env.HORA_INICIO || '09:00';
const HORA_FIN = process.env.HORA_FIN || '19:00';
const INTERVALO = Math.max(10, parseInt(process.env.INTERVALO || '30', 10) || 30);
const MIN_ANTICIPACION = Math.max(0, parseInt(process.env.MIN_ANTICIPACION || '30', 10) || 0);
const DIAS_ABIERTOS = (process.env.DIAS_ABIERTOS || '1,2,3,4,5,6')
  .split(',')
  .map((d) => parseInt(d.trim(), 10))
  .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

// Máximo de citas activas por teléfono y día (0 = sin límite)
const MAX_CITAS_POR_DIA = Math.max(0, parseInt(process.env.MAX_CITAS_POR_DIA || '3', 10) || 0);

// Avisos por email al barbero (opcional: si SMTP_* está vacío, se desactivan)
const SHOP_EMAIL = (process.env.SHOP_EMAIL || '').trim();
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10) || 587;
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const SMTP_FROM = (process.env.SMTP_FROM || SHOP_EMAIL).trim();
const SMTP_SECURE = SMTP_PORT === 465 && process.env.SMTP_SECURE !== 'false';

const SERVICIOS = [
  'Corte de cabello',
  'Corte + Barba',
  'Afeitado / Barba',
  'Corte + Cejas',
  'Corte + Barba + Cejas',
  'Lavado y peinado',
  'Corte infantil',
  'Otro',
];

const ESTADOS = ['pendiente', 'confirmada', 'completada', 'cancelada'];

// ---------------------------------------------------------------------------
// Base de datos (SQLite con módulo nativo de Node)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// Se puede redirigir la base (útil para pruebas): DATABASE_PATH
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'citas.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS citas (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre   TEXT NOT NULL,
    telefono TEXT NOT NULL,
    fecha    TEXT NOT NULL,
    hora     TEXT NOT NULL,
    servicio TEXT NOT NULL,
    notas    TEXT DEFAULT '',
    estado   TEXT NOT NULL DEFAULT 'pendiente',
    creado   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_slot
    ON citas(fecha, hora) WHERE estado != 'cancelada';
  CREATE INDEX IF NOT EXISTS idx_fecha ON citas(fecha);
  CREATE INDEX IF NOT EXISTS idx_telefono ON citas(telefono);
  CREATE TABLE IF NOT EXISTS sesiones (
    token  TEXT PRIMARY KEY,
    expira INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// Migración ligera: marca si ya se envió el recordatorio de WhatsApp de una cita.
try {
  db.exec('ALTER TABLE citas ADD COLUMN recordatorio_enviado INTEGER DEFAULT 0');
} catch {
  // La columna ya existe.
}

// Ajustes persistentes (sobreviven reinicios). Ej: tienda abierta/cerrada.
function leerAjuste(clave, porDefecto) {
  try {
    const fila = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave);
    return fila ? fila.valor : porDefecto;
  } catch {
    return porDefecto;
  }
}

function guardarAjuste(clave, valor) {
  db.prepare(
    `INSERT INTO ajustes (clave, valor) VALUES (?, ?)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`
  ).run(clave, String(valor));
}

function tiendaAbierta() {
  return leerAjuste('shop_abierto', '1') === '1';
}

// ---------------------------------------------------------------------------
// Configuración editable en caliente (se guarda en la tabla "ajustes")
// Los valores de las variables de entorno son solo el punto de partida.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  shopName: SHOP_NAME,
  logo: '✂️',
  logoPanel: '💈',
  tagline: 'Reserva tu cita en segundos',
  footer: '',
  whatsapp: SHOP_WHATSAPP,
  horaInicio: HORA_INICIO,
  horaFin: HORA_FIN,
  intervalo: INTERVALO,
  diasAbiertos: DIAS_ABIERTOS,
  minAnticipacion: MIN_ANTICIPACION,
  maxCitasPorDia: MAX_CITAS_POR_DIA,
  servicios: SERVICIOS,
  colores: {
    principal: '#f2b544',
    principalOscuro: '#d99e2c',
    fondo: '#0e1013',
    tema: '#0e1013',
  },
  textos: {
    heroTitulo: '',
    heroSubtitulo: 'Reserva tu cita en segundos',
    etiquetaNombre: '1. Tu nombre',
    etiquetaTelefono: '2. Número de teléfono',
    etiquetaFecha: '3. Fecha de la cita',
    etiquetaHora: '4. Hora',
    etiquetaServicio: '5. ¿Qué te vas a hacer?',
    botonReservar: 'Reservar cita',
    botonMisCitas: '📋 Ver / cancelar mis citas',
    tituloConfirmacion: '¡Cita reservada!',
    subtituloConfirmacion: 'Te esperamos. Guarda estos datos.',
    tituloPanel: 'Panel del barbero',
    tituloLogin: 'Acceso restringido',
    subtituloLogin: 'Acceso restringido',
  },
  passwordHash: null,
  openwa: {
    habilitado: false,
    url: OPENWA_URL,
    apiKey: OPENWA_API_KEY,
    sesion: OPENWA_SESSION,
    avisoBarbero: true,
    confirmarCliente: true,
    recordatorioCliente: true,
    avisoCancelacionCliente: true,
    barberoNumero: SHOP_WHATSAPP,
    recordatorioHora: '18:00',
    plantillas: {
      nuevaCita:
        '💈 Nueva cita reservada\n{nombre} · {fecha} {hora}\nServicio: {servicio}\nTel: {telefono}{notas}',
      cancelacionBarbero:
        '❌ {nombre} canceló su cita\n{fecha} {hora} · {servicio}\nTel: {telefono}',
      confirmacion:
        '✅ ¡Hola {nombre}! Tu cita en {negocio} quedó reservada para el {fecha} a las {hora}.\nServicio: {servicio}\nSi no puedes asistir, avísanos por aquí.',
      recordatorio:
        '⏰ Hola {nombre}, te recordamos tu cita en {negocio} el {fecha} a las {hora}. ¡Te esperamos!',
      cancelacion:
        'Hola {nombre}, tu cita en {negocio} del {fecha} a las {hora} fue cancelada. Escríbenos para reprogramar.',
    },
  },
};

function mezclar(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
    ) {
      mezclar(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

let CONFIG = null;

function cargarConfig() {
  let guardado = {};
  try {
    guardado = JSON.parse(leerAjuste('config', '{}')) || {};
  } catch {
    guardado = {};
  }
  CONFIG = mezclar(structuredClone(DEFAULTS), guardado);
  return CONFIG;
}

function cfg() {
  if (!CONFIG) cargarConfig();
  return CONFIG;
}

function guardarConfig(parcial) {
  let guardado = {};
  try {
    guardado = JSON.parse(leerAjuste('config', '{}')) || {};
  } catch {
    guardado = {};
  }
  mezclar(guardado, parcial);
  guardarAjuste('config', JSON.stringify(guardado));
  cargarConfig();
  return CONFIG;
}

cargarConfig();

// ---------------------------------------------------------------------------
// Contraseña (permite cambiarla desde la sección de desarrollador)
// ---------------------------------------------------------------------------
function hashPassword(pass) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), sal, 64).toString('hex');
  return `${sal}:${hash}`;
}

function verificarPassword(pass) {
  return verificarContra(String(pass), cfg().passwordHash, ADMIN_PASSWORD);
}

function verificarPasswordDev(pass) {
  return verificarContra(String(pass), null, DEV_PASSWORD);
}

function verificarContra(pass, hashGuardado, porDefecto) {
  if (!hashGuardado) {
    const a = Buffer.from(String(pass));
    const b = Buffer.from(String(porDefecto));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [sal, hash] = String(hashGuardado).split(':');
  if (!sal || !hash) return false;
  const calc = crypto.scryptSync(String(pass), sal, 64).toString('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Iconos subidos por el usuario (se sirven por encima de los estáticos)
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });



// Copia de seguridad diaria de la base (data/backups). Conserva las 14 más recientes.
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function crearBackup() {
  if (!fs.existsSync(DB_PATH)) return;
  try {
    const destino = path.join(BACKUP_DIR, `citas-${hoyISO()}.db`);
    if (!fs.existsSync(destino)) fs.copyFileSync(DB_PATH, destino);
    const sobrantes = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('citas-'))
      .sort()
      .reverse()
      .slice(14);
    for (const f of sobrantes) {
      fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    }
  } catch (err) {
    console.error('No se pudo crear el backup:', err.message);
  }
}
crearBackup();
setInterval(crearBackup, 24 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function aMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function deMinutos(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function generarHoras() {
  const c = cfg();
  const horas = [];
  const fin = aMinutos(c.horaFin);
  for (let t = aMinutos(c.horaInicio); t + c.intervalo <= fin; t += c.intervalo) {
    horas.push(deMinutos(t));
  }
  return horas;
}

function hoyISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function esFechaValida(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const [a, m, d] = fecha.split('-').map(Number);
  const dt = new Date(a, m - 1, d);
  return dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function diaAbierto(fecha) {
  const dia = new Date(`${fecha}T12:00:00`).getDay();
  return cfg().diasAbiertos.includes(dia);
}

function minutosHasta(fecha, hora) {
  const ahora = new Date();
  const cita = new Date(`${fecha}T${hora}:00`);
  return (cita.getTime() - ahora.getTime()) / 60000;
}

function soloDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function filaACita(row) {
  return { ...row };
}

// ---------------------------------------------------------------------------
// Sesiones del panel (en SQLite para que sobrevivan reinicios)
// ---------------------------------------------------------------------------
const sesiones = new Map(); // token -> fecha de expiración (ms)

function cargarSesiones() {
  for (const f of db.prepare('SELECT token, expira FROM sesiones').all()) {
    sesiones.set(f.token, f.expira);
  }
}
cargarSesiones();

function crearToken(scope = 'admin') {
  const prefijo = scope === 'dev' ? 'dev1_' : 'adm1_';
  const token = prefijo + crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  sesiones.set(token, exp);
  try {
    db.prepare('INSERT INTO sesiones (token, expira) VALUES (?, ?)').run(token, exp);
  } catch {}
  return token;
}

// Devuelve el alcance de un token válido: 'dev', 'admin' o null.
function alcanceToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.query.token || '');
  if (!token) return null;
  let exp = sesiones.get(token);
  if (exp === undefined) {
    const fila = db.prepare('SELECT expira FROM sesiones WHERE token = ?').get(token);
    if (!fila) return null;
    exp = fila.expira;
    sesiones.set(token, exp);
  }
  if (exp < Date.now()) {
    sesiones.delete(token);
    try { db.prepare('DELETE FROM sesiones WHERE token = ?').run(token); } catch {}
    return null;
  }
  // Los tokens sin prefijo son de sesiones antiguas: equivalen al panel.
  return token.startsWith('dev1_') ? 'dev' : 'admin';
}

function tokenValido(req) {
  return alcanceToken(req) === 'admin';
}

function requiereAuth(req, res, next) {
  if (tokenValido(req)) return next();
  res.status(401).json({ error: 'No autorizado. Inicia sesión de nuevo.' });
}

function requiereDev(req, res, next) {
  if (alcanceToken(req) === 'dev') return next();
  res.status(401).json({ error: 'No autorizado. Entra a la sección de desarrollador.' });
}

// Limpieza periódica de sesiones vencidas
setInterval(() => {
  const ahora = Date.now();
  for (const [t, exp] of sesiones) if (exp < ahora) sesiones.delete(t);
  try { db.prepare('DELETE FROM sesiones WHERE expira < ?').run(ahora); } catch {}
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Protección del login (fuerza bruta por IP)
// ---------------------------------------------------------------------------
const MAX_INTENTOS = 5;
const VENTANA_LOGIN = 15 * 60 * 1000; // 15 minutos
const intentosLogin = new Map(); // ip -> { count, bloqueadoHasta }

function loginBloqueado(ip) {
  const reg = intentosLogin.get(ip);
  if (!reg) return 0;
  if (reg.bloqueadoHasta && reg.bloqueadoHasta > Date.now()) {
    return Math.ceil((reg.bloqueadoHasta - Date.now()) / 1000);
  }
  if (reg.bloqueadoHasta && reg.bloqueadoHasta <= Date.now()) intentosLogin.delete(ip);
  return 0;
}

function registrarFallo(ip) {
  const reg = intentosLogin.get(ip) || { count: 0, bloqueadoHasta: 0 };
  reg.count += 1;
  if (reg.count >= MAX_INTENTOS) {
    reg.bloqueadoHasta = Date.now() + VENTANA_LOGIN;
    reg.count = 0;
  }
  intentosLogin.set(ip, reg);
}

function limpiarIntentos(ip) {
  intentosLogin.delete(ip);
}

setInterval(() => {
  const ahora = Date.now();
  for (const [ip, reg] of intentosLogin) {
    if (reg.bloqueadoHasta && reg.bloqueadoHasta <= ahora) intentosLogin.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Avisos por email al barbero (opcional, usa SMTP si está configurado)
// ---------------------------------------------------------------------------
let smtp = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    const nodemailer = require('nodemailer');
    smtp = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  } catch (err) {
    console.error('No se pudo iniciar el envío de emails:', err.message);
  }
}

function enviarEmail(asunto, texto) {
  if (!smtp || !SHOP_EMAIL) return;
  Promise.resolve()
    .then(() => smtp.sendMail({ from: SMTP_FROM, to: SHOP_EMAIL, subject: asunto, text: texto }))
    .catch((err) => console.error('Email no enviado:', err.message));
}

// ---------------------------------------------------------------------------
// WhatsApp vía OpenWA (gateway HTTP con motor Baileys)
// Se conecta a un OpenWA self-hosted: {OPENWA_URL}/api con cabecera X-API-Key.
// Si no está configurado o falla, la app sigue funcionando sin WhatsApp.
// ---------------------------------------------------------------------------
function waConfig() {
  return cfg().openwa || {};
}

function waConfigurado() {
  const w = waConfig();
  return !!(w.habilitado && w.url && w.apiKey && w.sesion);
}

// OpenWA identifica la sesión por su ID en las rutas; aquí aceptamos tanto el
// ID como el nombre (lo que se escribe en el panel) y resolvemos el ID real.
let _waSesionCache = { nombre: null, id: null, exp: 0 };
async function waSesionId() {
  const w = waConfig();
  const sesion = String(w.sesion || '').trim();
  if (!sesion) return null;
  const ahora = Date.now();
  if (_waSesionCache.nombre === sesion && _waSesionCache.id && _waSesionCache.exp > ahora) {
    return _waSesionCache.id;
  }
  const sesiones = await waFetch('/sessions');
  const lista = Array.isArray(sesiones) ? sesiones : [];
  const s = lista.find((x) => x.id === sesion || x.name === sesion);
  if (!s) return null;
  _waSesionCache = { nombre: sesion, id: s.id, exp: ahora + 60000 };
  return s.id;
}

function normalizarChatId(numero) {
  const n = soloDigitos(numero);
  if (!n || n.length < 8) return null;
  return `${n}@c.us`;
}

async function waFetch(ruta, opciones = {}) {
  const w = waConfig();
  const base = String(w.url || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/api${ruta}`, {
    ...opciones,
    headers: {
      'X-API-Key': w.apiKey || '',
      'Content-Type': 'application/json',
      ...(opciones.headers || {}),
    },
  });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (data && data.message) {
      msg = Array.isArray(data.message) ? data.message.join(', ') : String(data.message);
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function enviarWhatsApp(numero, texto) {
  if (!waConfigurado()) return { omitido: true };
  const chatId = normalizarChatId(numero);
  if (!chatId) throw new Error('Número de WhatsApp inválido.');
  const sesionId = await waSesionId();
  if (!sesionId) throw new Error('Sesión de WhatsApp no encontrada en OpenWA.');
  return waFetch(`/sessions/${encodeURIComponent(sesionId)}/messages/send-text`, {
    method: 'POST',
    body: JSON.stringify({ chatId, text: String(texto || '') }),
  });
}

function enviarWhatsAppSeguro(numero, texto, etiqueta) {
  enviarWhatsApp(numero, texto).catch((err) => {
    console.error(`WhatsApp (${etiqueta || 'mensaje'}) no enviado:`, err.message);
  });
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

function mananaISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function renderPlantilla(texto, cita) {
  const vars = {
    nombre: cita.nombre || '',
    fecha: fechaCorta(cita.fecha),
    hora: cita.hora || '',
    servicio: cita.servicio || '',
    telefono: cita.telefono || '',
    notas: cita.notas ? `\nNotas: ${cita.notas}` : '',
    negocio: cfg().shopName,
  };
  return String(texto || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function plantilla(nombre) {
  const p = (waConfig().plantillas || {})[nombre];
  return p || '';
}

// ---- Avisos concretos ----
function waNuevaCita(cita) {
  const w = waConfig();
  if (w.avisoBarbero && w.barberoNumero) {
    enviarWhatsAppSeguro(w.barberoNumero, renderPlantilla(plantilla('nuevaCita'), cita), 'aviso nuevo (barbero)');
  }
  if (w.confirmarCliente) {
    enviarWhatsAppSeguro(cita.telefono, renderPlantilla(plantilla('confirmacion'), cita), 'confirmación (cliente)');
  }
}

function waCancelacionBarbero(cita) {
  const w = waConfig();
  if (w.avisoBarbero && w.barberoNumero) {
    enviarWhatsAppSeguro(w.barberoNumero, renderPlantilla(plantilla('cancelacionBarbero'), cita), 'cancelación (barbero)');
  }
}

function waCancelacionCliente(cita) {
  const w = waConfig();
  if (w.avisoCancelacionCliente) {
    enviarWhatsAppSeguro(cita.telefono, renderPlantilla(plantilla('cancelacion'), cita), 'cancelación (cliente)');
  }
}

// Recordatorios "el día antes" a partir de la hora configurada (se envían una vez).
function enviarRecordatorios() {
  const w = waConfig();
  if (!waConfigurado() || !w.recordatorioCliente) return;
  const [hh] = String(w.recordatorioHora || '18:00').split(':').map(Number);
  if (new Date().getHours() < (hh || 0)) return;
  let filas = [];
  try {
    filas = db
      .prepare(
        `SELECT * FROM citas
         WHERE fecha = ? AND estado NOT IN ('cancelada','completada')
           AND COALESCE(recordatorio_enviado, 0) = 0`
      )
      .all(mananaISO());
  } catch {
    return;
  }
  for (const cita of filas) {
    enviarWhatsAppSeguro(cita.telefono, renderPlantilla(plantilla('recordatorio'), cita), 'recordatorio');
    try {
      db.prepare('UPDATE citas SET recordatorio_enviado = 1 WHERE id = ?').run(cita.id);
    } catch {}
  }
}
setInterval(enviarRecordatorios, 10 * 60 * 1000).unref();
setTimeout(enviarRecordatorios, 30 * 1000).unref();


// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // IP real detrás de proxies (Railway/Render)
app.use(express.json({ limit: '4mb' }));

// Iconos subidos desde la sección de desarrollador: si existen, tienen prioridad
// sobre los estáticos por defecto de /public.
const ICONOS = {
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/favicon.png': 'favicon.png',
};
app.get(Object.keys(ICONOS), (req, res) => {
  const propio = path.join(UPLOADS_DIR, ICONOS[req.path]);
  if (fs.existsSync(propio)) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    return res.sendFile(propio);
  }
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', ICONOS[req.path]));
});

// Manifest dinámico: usa el nombre, color e iconos configurados.
app.get('/manifest.webmanifest', (_req, res) => {
  const c = cfg();
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('application/manifest+json');
  res.json({
    name: `${c.shopName} · Panel`,
    short_name: c.shopName.slice(0, 12) || 'Panel',
    start_url: '/panel',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: c.colores.fondo,
    theme_color: c.colores.tema,
    lang: 'es',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css|webmanifest)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/panel', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/dev', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'dev.html'));
});

// Config pública para la interfaz
app.get('/api/config', (_req, res) => {
  const c = cfg();
  res.json({
    shopName: c.shopName,
    logo: c.logo,
    logoPanel: c.logoPanel,
    tagline: c.tagline,
    footer: c.footer,
    whatsapp: c.whatsapp,
    horas: generarHoras(),
    diasAbiertos: c.diasAbiertos,
    minAnticipacion: c.minAnticipacion,
    servicios: c.servicios,
    colores: c.colores,
    textos: c.textos,
    abierto: tiendaAbierta(),
    hoy: hoyISO(),
  });
});

// Estado público de la barbería (abierta / cerrada por inactividad)
app.get('/api/estado', (_req, res) => {
  res.json({ abierto: tiendaAbierta() });
});

// Estado del servidor (para plataformas de hosting)
app.get('/api/health', (_req, res) => {
  let citas = 0;
  try {
    citas = db.prepare('SELECT COUNT(*) AS c FROM citas').get().c;
  } catch {
    citas = -1;
  }
  res.json({ ok: true, uptime: Math.round(process.uptime()), citas });
});

// Horas disponibles para una fecha
app.get('/api/slots', (req, res) => {
  const fecha = req.query.fecha;
  if (!esFechaValida(fecha)) {
    return res.status(400).json({ error: 'Fecha no válida.' });
  }
  if (!diaAbierto(fecha)) {
    return res.json({ fecha, cerrado: true, horas: [] });
  }

  const pasada = fecha < hoyISO();
  const ocupadas = new Set(
    db
      .prepare("SELECT hora FROM citas WHERE fecha = ? AND estado != 'cancelada'")
      .all(fecha)
      .map((r) => r.hora)
  );

  const c = cfg();
  const horas = generarHoras().map((hora) => {
    let disponible = !pasada && !ocupadas.has(hora);
    if (disponible && fecha === hoyISO() && minutosHasta(fecha, hora) < c.minAnticipacion) {
      disponible = false;
    }
    return { hora, disponible };
  });

  res.json({ fecha, cerrado: false, horas });
});

// Crear cita (cliente)
app.post('/api/citas', (req, res) => {
  if (!tiendaAbierta()) {
    return res.status(400).json({
      error: 'Ahora mismo no estamos recibiendo reservas (barbería cerrada). Intenta más tarde.',
    });
  }
  const { nombre, telefono, fecha, hora, servicio, notas } = req.body || {};
  const c = cfg();

  const errores = [];
  const nombreLimpio = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (nombreLimpio.length < 3) errores.push('Escribe tu nombre completo.');

  const tel = soloDigitos(telefono);
  if (tel.length < 7 || tel.length > 15) errores.push('El teléfono debe tener entre 7 y 15 dígitos (con código de país).');

  if (!esFechaValida(fecha || '')) errores.push('La fecha no es válida.');
  else if (!diaAbierto(fecha)) errores.push('Ese día no estamos abiertos.');
  else if (fecha < hoyISO()) errores.push('No se pueden agendar citas en el pasado.');

  if (!generarHoras().includes(hora)) errores.push('La hora seleccionada no está disponible.');
  else if (fecha === hoyISO() && minutosHasta(fecha, hora) < c.minAnticipacion) {
    errores.push(`Esa hora ya pasó o es muy próxima (mínimo ${c.minAnticipacion} min de anticipación).`);
  }

  const servicioLimpio = String(servicio || '').trim();
  if (!servicioLimpio) errores.push('Elige el servicio que te vas a hacer.');
  if (servicioLimpio.length > 120) errores.push('Descripción del servicio demasiado larga.');

  const notasLimpias = String(notas || '').trim().slice(0, 300);

  if (errores.length) return res.status(400).json({ error: errores.join(' ') });

  // Límite de citas activas por teléfono al día
  if (c.maxCitasPorDia > 0) {
    const ya = db
      .prepare("SELECT COUNT(*) AS c FROM citas WHERE telefono = ? AND fecha = ? AND estado != 'cancelada'")
      .get(tel, fecha).c;
    if (ya >= c.maxCitasPorDia) {
      return res.status(400).json({
        error: `Ya tienes ${ya} cita(s) ese día (máximo ${c.maxCitasPorDia}). Elige otra fecha.`,
      });
    }
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO citas (nombre, telefono, fecha, hora, servicio, notas)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(nombreLimpio, tel, fecha, hora, servicioLimpio, notasLimpias);

    const row = db.prepare('SELECT * FROM citas WHERE id = ?').get(Number(result.lastInsertRowid));
    if (SHOP_EMAIL) {
      enviarEmail(
        `Nueva cita · ${fecha} ${hora}`,
        `${nombreLimpio} reservó para el ${fecha} a las ${hora}.\nServicio: ${servicioLimpio}\nTeléfono: ${tel}${notasLimpias ? `\nNotas: ${notasLimpias}` : ''}`
      );
    }
    if (waConfigurado()) waNuevaCita(row);
    res.status(201).json({ ok: true, cita: filaACita(row) });
  } catch (err) {
    if (String(err.message || err).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Esa hora acaba de ser reservada. Elige otra.' });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar la cita. Intenta de nuevo.' });
  }
});

// Consultar una cita concreta (cliente). Exige el teléfono para no filtrar datos ajenos.
app.get('/api/citas/mia', (req, res) => {
  const id = parseInt(req.query.id, 10);
  const tel = soloDigitos(req.query.telefono);
  if (!Number.isInteger(id) || tel.length < 7) {
    return res.status(400).json({ error: 'Faltan datos para consultar la cita.' });
  }
  const row = db
    .prepare('SELECT id, nombre, telefono, fecha, hora, servicio, notas, estado FROM citas WHERE id = ?')
    .get(id);
  if (!row || row.telefono !== tel) {
    return res.status(404).json({ error: 'No encontramos esa cita para ese teléfono.' });
  }
  const { telefono, ...publica } = row;
  res.json(publica);
});

// Cancelar la propia cita (cliente). Exige el teléfono y que no haya pasado.
app.post('/api/citas/:id/cancelar', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tel = soloDigitos((req.body || {}).telefono);
  if (!Number.isInteger(id) || tel.length < 7) {
    return res.status(400).json({ error: 'Faltan datos para cancelar la cita.' });
  }
  const row = db.prepare('SELECT * FROM citas WHERE id = ?').get(id);
  if (!row || row.telefono !== tel) {
    return res.status(404).json({ error: 'No encontramos esa cita para ese teléfono.' });
  }
  if (row.estado === 'cancelada') {
    return res.status(409).json({ error: 'Esa cita ya estaba cancelada.' });
  }
  if (row.estado === 'completada') {
    return res.status(409).json({ error: 'Esa cita ya fue completada y no se puede cancelar.' });
  }
  if (row.fecha < hoyISO()) {
    return res.status(409).json({ error: 'Esa cita ya pasó.' });
  }
  db.prepare("UPDATE citas SET estado = 'cancelada' WHERE id = ?").run(id);
  if (SHOP_EMAIL) {
    enviarEmail(
      `Cita cancelada por el cliente · ${row.fecha} ${row.hora}`,
      `${row.nombre} canceló su cita del ${row.fecha} a las ${row.hora} (${row.servicio}). Teléfono: ${row.telefono}`
    );
  }
  if (waConfigurado()) waCancelacionBarbero(row);
  res.json({ ok: true, id, estado: 'cancelada' });
});

// ---------------------------------------------------------------------------
// Panel del barbero
// ---------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'desconocida';
  const espera = loginBloqueado(ip);
  if (espera) {
    res.set('Retry-After', String(espera));
    return res.status(429).json({
      error: `Demasiados intentos. Espera ${Math.ceil(espera / 60)} minuto(s) e intenta de nuevo.`,
    });
  }
  const escrito = String((req.body || {}).password || '');
  if (!verificarPassword(escrito)) {
    registrarFallo(ip);
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  limpiarIntentos(ip);
  res.json({ token: crearToken() });
});

// Acceso a la sección de desarrollador (contraseña propia, distinta a la del panel)
app.post('/api/dev/login', (req, res) => {
  const ip = req.ip || 'desconocida';
  const espera = loginBloqueado(ip);
  if (espera) {
    res.set('Retry-After', String(espera));
    return res.status(429).json({
      error: `Demasiados intentos. Espera ${Math.ceil(espera / 60)} minuto(s) e intenta de nuevo.`,
    });
  }
  const escrito = String((req.body || {}).password || '');
  if (!verificarPasswordDev(escrito)) {
    registrarFallo(ip);
    return res.status(401).json({ error: 'Contraseña de desarrollador incorrecta.' });
  }
  limpiarIntentos(ip);
  res.json({ token: crearToken('dev') });
});

// Activar / desactivar modo "no laborando" (bloquea reservas de clientes)
app.post('/api/admin/estado', requiereAuth, (req, res) => {
  const abierto = !!(req.body || {}).abierto;
  guardarAjuste('shop_abierto', abierto ? '1' : '0');
  res.json({ ok: true, abierto });
});

// ---------------------------------------------------------------------------
// Configuración / sección de desarrollador
// ---------------------------------------------------------------------------
function configPublicaCompleta() {
  const c = cfg();
  return {
    ...c,
    passwordHash: undefined,
    tienePassword: !!c.passwordHash,
    horas: generarHoras(),
  };
}

app.get('/api/dev/config', requiereDev, (_req, res) => {
  res.json(configPublicaCompleta());
});

// Normaliza y valida el subconjunto de ajustes editables
function normalizarConfig(body) {
  const c = body && typeof body === 'object' ? body : {};
  const out = {};

  if (typeof c.shopName === 'string') out.shopName = c.shopName.trim().slice(0, 60) || 'Mi Barbería';
  if (typeof c.logo === 'string') out.logo = c.logo.slice(0, 8);
  if (typeof c.logoPanel === 'string') out.logoPanel = c.logoPanel.slice(0, 8);
  if (typeof c.tagline === 'string') out.tagline = c.tagline.slice(0, 120);
  if (typeof c.footer === 'string') out.footer = c.footer.slice(0, 120);
  if (typeof c.whatsapp === 'string') out.whatsapp = soloDigitos(c.whatsapp);

  if (typeof c.horaInicio === 'string' && /^\d{1,2}:\d{2}$/.test(c.horaInicio)) out.horaInicio = c.horaInicio;
  if (typeof c.horaFin === 'string' && /^\d{1,2}:\d{2}$/.test(c.horaFin)) out.horaFin = c.horaFin;
  if (c.intervalo !== undefined) out.intervalo = Math.min(240, Math.max(5, parseInt(c.intervalo, 10) || 30));
  if (c.minAnticipacion !== undefined) out.minAnticipacion = Math.min(1440, Math.max(0, parseInt(c.minAnticipacion, 10) || 0));
  if (c.maxCitasPorDia !== undefined) out.maxCitasPorDia = Math.min(100, Math.max(0, parseInt(c.maxCitasPorDia, 10) || 0));
  if (Array.isArray(c.diasAbiertos)) {
    out.diasAbiertos = [...new Set(c.diasAbiertos.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))].sort();
  }
  if (Array.isArray(c.servicios)) {
    out.servicios = c.servicios
      .map((s) => String(s || '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 50);
  }
  if (c.colores && typeof c.colores === 'object') {
    out.colores = {};
    for (const k of ['principal', 'principalOscuro', 'fondo', 'tema']) {
      if (typeof c.colores[k] === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.colores[k])) out.colores[k] = c.colores[k];
    }
  }
  if (c.textos && typeof c.textos === 'object') {
    out.textos = {};
    for (const [k, v] of Object.entries(c.textos)) {
      if (typeof v === 'string') out.textos[String(k).slice(0, 40)] = v.slice(0, 120);
    }
  }
  if (c.openwa && typeof c.openwa === 'object') {
    const w = c.openwa;
    const ow = {};
    for (const k of ['habilitado', 'avisoBarbero', 'confirmarCliente', 'recordatorioCliente', 'avisoCancelacionCliente']) {
      if (typeof w[k] === 'boolean') ow[k] = w[k];
    }
    if (typeof w.url === 'string') ow.url = w.url.trim().slice(0, 300);
    if (typeof w.apiKey === 'string') ow.apiKey = w.apiKey.trim().slice(0, 300);
    if (typeof w.sesion === 'string') ow.sesion = w.sesion.trim().slice(0, 120) || 'barberia';
    if (typeof w.barberoNumero === 'string') ow.barberoNumero = soloDigitos(w.barberoNumero).slice(0, 20);
    if (typeof w.recordatorioHora === 'string' && /^\d{1,2}:\d{2}$/.test(w.recordatorioHora)) {
      ow.recordatorioHora = w.recordatorioHora;
    }
    if (w.plantillas && typeof w.plantillas === 'object') {
      ow.plantillas = {};
      for (const [k, v] of Object.entries(w.plantillas)) {
        if (typeof v === 'string') ow.plantillas[String(k).slice(0, 40)] = v.slice(0, 1000);
      }
    }
    out.openwa = ow;
  }
  return out;
}

app.put('/api/dev/config', requiereDev, (req, res) => {
  const limpio = normalizarConfig(req.body);
  guardarConfig(limpio);
  res.json({ ok: true, config: configPublicaCompleta() });
});

// Restablecer un grupo o toda la configuración a los valores por defecto.
// La contraseña personalizada del panel se conserva para no dejar fuera al barbero.
app.post('/api/dev/config/reset', requiereDev, (req, res) => {
  const grupo = String((req.body || {}).grupo || 'todo');
  const actual = JSON.parse(leerAjuste('config', '{}')) || {};
  if (grupo === 'todo') {
    const nuevo = {};
    if (actual.passwordHash) nuevo.passwordHash = actual.passwordHash;
    guardarAjuste('config', JSON.stringify(nuevo));
  } else {
    delete actual[grupo];
    guardarAjuste('config', JSON.stringify(actual));
  }
  cargarConfig();
  res.json({ ok: true, config: configPublicaCompleta() });
});

// Cambiar la contraseña del panel del barbero
app.post('/api/dev/password', requiereDev, (req, res) => {
  const { actual, nueva } = req.body || {};
  if (!verificarPassword(String(actual || ''))) {
    return res.status(401).json({ error: 'La contraseña actual del panel no es correcta.' });
  }
  if (String(nueva || '').length < 4) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  }
  guardarConfig({ passwordHash: hashPassword(nueva) });
  res.json({ ok: true });
});

// Subir iconos de la app (se reciben como dataURL PNG ya redimensionados por el navegador)
app.post('/api/dev/icono', requiereDev, (req, res) => {
  const { icon192, icon512, icon180, favicon } = req.body || {};
  const guardar = (dataUrl, nombre) => {
    if (typeof dataUrl !== 'string') return false;
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
    if (!m) return false;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) return false;
    fs.writeFileSync(path.join(UPLOADS_DIR, nombre), buf);
    return true;
  };
  const hechos = [];
  if (guardar(icon192, 'icon-192.png')) hechos.push('192');
  if (guardar(icon512, 'icon-512.png')) hechos.push('512');
  if (guardar(icon180, 'apple-touch-icon.png')) hechos.push('180');
  if (guardar(favicon || icon192, 'favicon.png')) hechos.push('favicon');
  if (!hechos.length) return res.status(400).json({ error: 'No se recibió ninguna imagen válida.' });
  res.json({ ok: true, guardados: hechos, v: Date.now() });
});

// Quitar los iconos subidos (vuelve a los de fábrica)
app.delete('/api/dev/icono', requiereDev, (_req, res) => {
  for (const nombre of Object.values(ICONOS)) {
    try { fs.rmSync(path.join(UPLOADS_DIR, nombre), { force: true }); } catch {}
  }
  res.json({ ok: true, v: Date.now() });
});

// ---------------------------------------------------------------------------
// WhatsApp (OpenWA) desde la sección de desarrollador
// ---------------------------------------------------------------------------
// Extrae el QR de las formas que puede devolver OpenWA.
function extraerQr(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  return data.qr || data.qrCode || data.code || data.base64 || data.data || null;
}

app.get('/api/dev/whatsapp', requiereDev, async (_req, res) => {
  const w = waConfig();
  const info = {
    configurado: !!(w.url && w.apiKey && w.sesion),
    habilitado: !!w.habilitado,
    url: w.url || '',
    sesion: w.sesion || '',
  };
  if (!info.configurado) return res.json(info);

  try {
    const salud = await waFetch('/health');
    info.servidor = (salud && salud.status) || 'ok';
    info.version = (salud && salud.version) || null;
  } catch (e) {
    info.servidor = 'error';
    info.error = e.message;
    return res.json(info);
  }

  try {
    const sesiones = await waFetch('/sessions');
    const lista = Array.isArray(sesiones) ? sesiones : [];
    const s = lista.find((x) => x.id === w.sesion || x.name === w.sesion);
    if (!s) {
      info.sesionExiste = false;
      return res.json(info);
    }
    info.sesionExiste = true;
    info.estado = s.status || null;
    info.conectado = s.status === 'ready';
    if (!info.conectado) {
      try {
        info.qr = extraerQr(await waFetch(`/sessions/${encodeURIComponent(s.id)}/qr`));
      } catch (e) {
        info.qrError = e.message;
      }
    }
  } catch (e) {
    info.error = e.message;
  }
  res.json(info);
});

// Crea (si hace falta) y arranca la sesión de OpenWA.
app.post('/api/dev/whatsapp/iniciar', requiereDev, async (_req, res) => {
  const w = waConfig();
  if (!w.url || !w.apiKey || !w.sesion) {
    return res.status(400).json({ error: 'Configura la URL, la API key y la sesión primero.' });
  }
  try {
    let existe = false;
    try {
      const sesiones = await waFetch('/sessions');
      existe = Array.isArray(sesiones) && sesiones.some((x) => x.id === w.sesion || x.name === w.sesion);
    } catch {}
    if (!existe) {
      await waFetch('/sessions', { method: 'POST', body: JSON.stringify({ name: w.sesion }) });
    }
    const sesionId = await waSesionId();
    if (!sesionId) throw new Error('Sesión de WhatsApp no encontrada en OpenWA.');
    try {
      await waFetch(`/sessions/${encodeURIComponent(sesionId)}/start`, { method: 'POST' });
    } catch (e) {
      // Ya estaba arrancada (400) no es un error real.
      if (e.status !== 400) throw e;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Enviar un mensaje de prueba.
app.post('/api/dev/whatsapp/probar', requiereDev, async (req, res) => {
  const numero = soloDigitos((req.body || {}).numero);
  if (numero.length < 8) {
    return res.status(400).json({ error: 'Escribe un número de WhatsApp válido con código de país.' });
  }
  if (!waConfigurado()) {
    return res.status(400).json({ error: 'El WhatsApp automático está desactivado o sin configurar.' });
  }
  const texto = `✅ Prueba de ${cfg().shopName}: los avisos de WhatsApp funcionan.`;
  try {
    const r = await enviarWhatsApp(numero, texto);
    res.json({ ok: true, resultado: r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/admin/citas', requiereAuth, (req, res) => {
  const { fecha, q } = req.query;
  const where = [];
  const params = [];
  if (fecha && fecha !== 'todas') {
    where.push('fecha = ?');
    params.push(fecha);
  }
  const term = String(q || '').trim().replace(/[%_]/g, '');
  if (term) {
    const like = `%${term}%`;
    where.push('(nombre LIKE ? OR telefono LIKE ?)');
    params.push(like, like);
  }
  const sql =
    'SELECT * FROM citas' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY fecha ASC, hora ASC';
  res.json({ citas: db.prepare(sql).all(...params) });
});

// Novedades: citas creadas con id mayor a "desde" (el panel las usa para avisar
// de nuevas reservas sin importar el filtro de fecha que esté viendo).
app.get('/api/admin/nuevas', requiereAuth, (req, res) => {
  const desde = parseInt(req.query.desde, 10) || 0;
  const citas = db
    .prepare('SELECT * FROM citas WHERE id > ? ORDER BY id ASC')
    .all(desde);
  const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM citas').get().m;
  res.json({ citas, maxId });
});

app.patch('/api/admin/citas/:id', requiereAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { estado } = req.body || {};
  if (!ESTADOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  const previa = db.prepare('SELECT * FROM citas WHERE id = ?').get(id);
  const result = db.prepare('UPDATE citas SET estado = ? WHERE id = ?').run(estado, id);
  if (!Number(result.changes)) return res.status(404).json({ error: 'Cita no encontrada.' });
  // Avisar al cliente cuando el barbero cancela una cita que no estaba cancelada.
  if (estado === 'cancelada' && previa && previa.estado !== 'cancelada' && waConfigurado()) {
    waCancelacionCliente(previa);
  }
  res.json({ ok: true, cita: db.prepare('SELECT * FROM citas WHERE id = ?').get(id) });
});

app.delete('/api/admin/citas/:id', requiereAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM citas WHERE id = ?').run(id);
  if (!Number(result.changes)) return res.status(404).json({ error: 'Cita no encontrada.' });
  res.json({ ok: true });
});

// Exportar todas las citas como JSON (backup manual)
app.get('/api/admin/export', requiereAuth, (_req, res) => {
  const filas = db.prepare('SELECT * FROM citas ORDER BY fecha ASC, hora ASC').all();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="citas-${hoyISO()}.json"`);
  res.send(
    JSON.stringify(
      { app: 'barberia-citas', version: 1, exportado: new Date().toISOString(), citas: filas },
      null,
      2
    )
  );
});

// Importar citas desde un JSON ({ citas: [...] } o [...]). No reemplaza, "une".
app.post('/api/admin/import', requiereAuth, (req, res) => {
  const body = req.body || {};
  const lista = Array.isArray(body) ? body : Array.isArray(body.citas) ? body.citas : null;
  if (!lista) {
    return res.status(400).json({ error: 'Envía un arreglo de citas o un objeto { citas: [...] }.' });
  }
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO citas (nombre, telefono, fecha, hora, servicio, notas, estado, creado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let importadas = 0;
  let omitidas = 0;
  for (const c of lista) {
    const estado = ESTADOS.includes(String(c.estado || '')) ? String(c.estado) : 'pendiente';
    try {
      const r = insertar.run(
        String(c.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        soloDigitos(c.telefono),
        String(c.fecha || ''),
        String(c.hora || ''),
        String(c.servicio || '').trim().slice(0, 120),
        String(c.notas || '').trim().slice(0, 300),
        estado,
        String(c.creado || new Date().toLocaleString('sv-SE')).slice(0, 19)
      );
      if (Number(r.changes)) importadas += 1;
      else omitidas += 1;
    } catch {
      omitidas += 1;
    }
  }
  res.json({ ok: true, importadas, omitidas });
});

// Estadísticas (total, por estado, últimos 14 días y servicios más pedidos)
app.get('/api/admin/stats', requiereAuth, (_req, res) => {
  const porEstado = Object.fromEntries(
    db
      .prepare('SELECT estado, COUNT(*) AS c FROM citas GROUP BY estado')
      .all()
      .map((r) => [r.estado, r.c])
  );
  const porDia = db
    .prepare(
      `SELECT fecha,
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN estado = 'cancelada' THEN 1 ELSE 0 END), 0) AS canceladas
       FROM citas
       GROUP BY fecha
       ORDER BY fecha DESC
       LIMIT 14`
    )
    .all();
  const servicios = db
    .prepare('SELECT servicio, COUNT(*) AS c FROM citas GROUP BY servicio ORDER BY c DESC LIMIT 6')
    .all();
  res.json({
    total: db.prepare('SELECT COUNT(*) AS c FROM citas').get().c,
    porEstado,
    porDia,
    servicios,
  });
});

// ---------------------------------------------------------------------------
// Rutas no encontradas y errores
// ---------------------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Datos inválidos en la petición.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Barbería "${cfg().shopName}" escuchando en http://localhost:${PORT}`);
    console.log(`Panel del barbero: http://localhost:${PORT}/panel`);
    console.log(`Sección de desarrollador: http://localhost:${PORT}/dev`);
    if (!cfg().passwordHash && ADMIN_PASSWORD === 'barbero123') {
      console.warn('AVISO: estás usando la contraseña por defecto. Cámbiala en /dev.');
    }
  });
}

module.exports = app;
// Cierra la conexión a la base (lo usa la prueba para poder borrar archivos temporales).
module.exports.cerrarBase = () => {
  try { db.close(); } catch {}
};
