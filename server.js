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
`);

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
  const horas = [];
  const fin = aMinutos(HORA_FIN);
  for (let t = aMinutos(HORA_INICIO); t + INTERVALO <= fin; t += INTERVALO) {
    horas.push(deMinutos(t));
  }
  return horas;
}

const HORAS = generarHoras();

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
  return DIAS_ABIERTOS.includes(dia);
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

function crearToken() {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  sesiones.set(token, exp);
  try {
    db.prepare('INSERT INTO sesiones (token, expira) VALUES (?, ?)').run(token, exp);
  } catch {}
  return token;
}

function tokenValido(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.query.token || '');
  if (!token) return false;
  let exp = sesiones.get(token);
  if (exp === undefined) {
    const fila = db.prepare('SELECT expira FROM sesiones WHERE token = ?').get(token);
    if (!fila) return false;
    exp = fila.expira;
    sesiones.set(token, exp);
  }
  if (exp < Date.now()) {
    sesiones.delete(token);
    try { db.prepare('DELETE FROM sesiones WHERE token = ?').run(token); } catch {}
    return false;
  }
  return true;
}

function requiereAuth(req, res, next) {
  if (tokenValido(req)) return next();
  res.status(401).json({ error: 'No autorizado. Inicia sesión de nuevo.' });
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
// Servidor
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // IP real detrás de proxies (Railway/Render)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/panel', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Config pública para la interfaz
app.get('/api/config', (_req, res) => {
  res.json({
    shopName: SHOP_NAME,
    whatsapp: SHOP_WHATSAPP,
    horas: HORAS,
    diasAbiertos: DIAS_ABIERTOS,
    minAnticipacion: MIN_ANTICIPACION,
    servicios: SERVICIOS,
    hoy: hoyISO(),
  });
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

  const horas = HORAS.map((hora) => {
    let disponible = !pasada && !ocupadas.has(hora);
    if (disponible && fecha === hoyISO() && minutosHasta(fecha, hora) < MIN_ANTICIPACION) {
      disponible = false;
    }
    return { hora, disponible };
  });

  res.json({ fecha, cerrado: false, horas });
});

// Crear cita (cliente)
app.post('/api/citas', (req, res) => {
  const { nombre, telefono, fecha, hora, servicio, notas } = req.body || {};

  const errores = [];
  const nombreLimpio = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (nombreLimpio.length < 3) errores.push('Escribe tu nombre completo.');

  const tel = soloDigitos(telefono);
  if (tel.length < 7 || tel.length > 15) errores.push('El teléfono debe tener entre 7 y 15 dígitos (con código de país).');

  if (!esFechaValida(fecha || '')) errores.push('La fecha no es válida.');
  else if (!diaAbierto(fecha)) errores.push('Ese día no estamos abiertos.');
  else if (fecha < hoyISO()) errores.push('No se pueden agendar citas en el pasado.');

  if (!HORAS.includes(hora)) errores.push('La hora seleccionada no está disponible.');
  else if (fecha === hoyISO() && minutosHasta(fecha, hora) < MIN_ANTICIPACION) {
    errores.push(`Esa hora ya pasó o es muy próxima (mínimo ${MIN_ANTICIPACION} min de anticipación).`);
  }

  const servicioLimpio = String(servicio || '').trim();
  if (!servicioLimpio) errores.push('Elige el servicio que te vas a hacer.');
  if (servicioLimpio.length > 120) errores.push('Descripción del servicio demasiado larga.');

  const notasLimpias = String(notas || '').trim().slice(0, 300);

  if (errores.length) return res.status(400).json({ error: errores.join(' ') });

  // Límite de citas activas por teléfono al día
  if (MAX_CITAS_POR_DIA > 0) {
    const ya = db
      .prepare("SELECT COUNT(*) AS c FROM citas WHERE telefono = ? AND fecha = ? AND estado != 'cancelada'")
      .get(tel, fecha).c;
    if (ya >= MAX_CITAS_POR_DIA) {
      return res.status(400).json({
        error: `Ya tienes ${ya} cita(s) ese día (máximo ${MAX_CITAS_POR_DIA}). Elige otra fecha.`,
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
  const intento = Buffer.from(String((req.body || {}).password || ''));
  const correcta = Buffer.from(ADMIN_PASSWORD);
  const coincide =
    intento.length === correcta.length && crypto.timingSafeEqual(intento, correcta);
  if (!coincide) {
    registrarFallo(ip);
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  limpiarIntentos(ip);
  res.json({ token: crearToken() });
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

app.patch('/api/admin/citas/:id', requiereAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { estado } = req.body || {};
  if (!ESTADOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  const result = db.prepare('UPDATE citas SET estado = ? WHERE id = ?').run(estado, id);
  if (!Number(result.changes)) return res.status(404).json({ error: 'Cita no encontrada.' });
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
    console.log(`Barbería "${SHOP_NAME}" escuchando en http://localhost:${PORT}`);
    console.log(`Panel del barbero: http://localhost:${PORT}/panel`);
    if (ADMIN_PASSWORD === 'barbero123') {
      console.warn('AVISO: estás usando la contraseña por defecto. Cámbiala con ADMIN_PASSWORD.');
    }
  });
}

module.exports = app;
// Cierra la conexión a la base (lo usa la prueba para poder borrar archivos temporales).
module.exports.cerrarBase = () => {
  try { db.close(); } catch {}
};
