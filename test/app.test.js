// Pruebas de la API (node --test, sin dependencias extra).
// Requiere Node >= 18 (usa fetch global). Se recomienda Node 24.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Base de datos y contraseña aisladas antes de cargar el servidor.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberia-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'citas.db');
process.env.ADMIN_PASSWORD = 'testpass123';
process.env.MAX_CITAS_POR_DIA = '3';

const app = require('../server.js');

let server;
let base;
let TOKEN = null;

function json(res) {
  return res.json().catch(() => ({}));
}

async function api(metodo, url, cuerpo, token) {
  const opts = { method: metodo, headers: {} };
  if (cuerpo !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(cuerpo);
  }
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${url}`, opts);
  return { status: res.status, body: await json(res) };
}

// Fecha futura que cae en día abierto (lunes 5 de enero de 2099)
function fechaFutura() {
  return '2099-01-05';
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  app.cerrarBase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health responde ok', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.citas, 'number');
});

test('config expone servicios y horario', async () => {
  const r = await api('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.ok(r.body.servicios.includes('Corte de cabello'));
  assert.ok(r.body.horas.length > 0);
});

test('slots devuelve horas para una fecha válida', async () => {
  const r = await api('GET', `/api/slots?fecha=${fechaFutura()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.cerrado, false);
  assert.ok(r.body.horas.length > 0);
});

test('slots rechaza una fecha no válida', async () => {
  const r = await api('GET', '/api/slots?fecha=no-es-fecha');
  assert.equal(r.status, 400);
});

test('crear cita válida responde 201', async () => {
  const r = await api('POST', '/api/citas', {
    nombre: 'Juan Pérez',
    telefono: '584121234567',
    fecha: fechaFutura(),
    hora: '09:00',
    servicio: 'Corte de cabello',
    notas: '',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.cita.estado, 'pendiente');
});

test('reservar el mismo slot devuelve 409', async () => {
  const r = await api('POST', '/api/citas', {
    nombre: 'Otra Persona',
    telefono: '58499887766',
    fecha: fechaFutura(),
    hora: '09:00',
    servicio: 'Afeitado / Barba',
  });
  assert.equal(r.status, 409);
});

test('crear cita en el pasado devuelve 400', async () => {
  const r = await api('POST', '/api/citas', {
    nombre: 'Ana Gómez',
    telefono: '58411223344',
    fecha: '2000-01-01',
    hora: '10:00',
    servicio: 'Corte de cabello',
  });
  assert.equal(r.status, 400);
});

test('límite de citas por teléfono y día (máx 3)', async () => {
  const horas = ['10:00', '10:30', '11:00', '11:30'];
  for (const h of horas.slice(0, 3)) {
    const r = await api('POST', '/api/citas', {
      nombre: 'Límite Test',
      telefono: '58455500000',
      fecha: fechaFutura(),
      hora: h,
      servicio: 'Corte de cabello',
    });
    assert.equal(r.status, 201, `debería aceptar ${h}`);
  }
  const r = await api('POST', '/api/citas', {
    nombre: 'Límite Test',
    telefono: '58455500000',
    fecha: fechaFutura(),
    hora: '11:30',
    servicio: 'Corte de cabello',
  });
  assert.equal(r.status, 400);
});

test('consultar mi cita exige teléfono', async () => {
  const r = await api('GET', '/api/citas/mia?id=1');
  assert.equal(r.status, 400);
});

test('consultar mi cita con teléfono incorrecto da 404', async () => {
  const r = await api('GET', '/api/citas/mia?id=1&telefono=58400000000');
  assert.equal(r.status, 404);
});

test('cancelar con teléfono correcto marca cancelada', async () => {
  const creada = await api('POST', '/api/citas', {
    nombre: 'Cancel Test',
    telefono: '58477700000',
    fecha: fechaFutura(),
    hora: '12:00',
    servicio: 'Corte de cabello',
  });
  const id = creada.body.cita.id;
  const r = await api('POST', `/api/citas/${id}/cancelar`, { telefono: '58477700000' });
  assert.equal(r.status, 200);
  assert.equal(r.body.estado, 'cancelada');
});

test('cancelar dos veces devuelve 409', async () => {
  const r = await api('POST', '/api/citas/1/cancelar', { telefono: '584121234567' });
  assert.equal(r.status, 200);
  const r2 = await api('POST', '/api/citas/1/cancelar', { telefono: '584121234567' });
  assert.equal(r2.status, 409);
});

test('login incorrecto da 401', async () => {
  const r = await api('POST', '/api/login', { password: 'incorrecta' });
  assert.equal(r.status, 401);
});

test('login correcto entrega token', async () => {
  const r = await api('POST', '/api/login', { password: 'testpass123' });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  TOKEN = r.body.token;
});

test('admin sin token da 401', async () => {
  const r = await api('GET', '/api/admin/citas?fecha=todas');
  assert.equal(r.status, 401);
});

test('admin listar y buscar con token', async () => {
  const r = await api('GET', '/api/admin/citas?fecha=todas&q=Juan', undefined, TOKEN);
  assert.equal(r.status, 200);
  assert.ok(r.body.citas.some((c) => c.nombre.includes('Juan')));
});

test('admin exportar entrega JSON de citas', async () => {
  const r = await api('GET', '/api/admin/export', undefined, TOKEN);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.citas));
});

test('admin importar añade citas nuevas', async () => {
  const r = await api(
    'POST',
    '/api/admin/import',
    {
      citas: [
        {
          nombre: 'Importada Uno',
          telefono: '58412300001',
          fecha: fechaFutura(),
          hora: '14:00',
          servicio: 'Corte + Barba',
          estado: 'confirmada',
        },
      ],
    },
    TOKEN
  );
  assert.equal(r.status, 200);
  assert.ok(r.body.importadas >= 1);
});

test('admin stats devuelve totales', async () => {
  const r = await api('GET', '/api/admin/stats', undefined, TOKEN);
  assert.equal(r.status, 200);
  assert.ok(r.body.total > 0);
  assert.ok(Array.isArray(r.body.porDia));
});

test('la IP se bloquea tras 5 intentos de login fallidos (429)', async () => {
  // Ejecutamos de último: el bloqueo de 15 min afecta al resto de pruebas.
  let status = 0;
  for (let i = 0; i < 6; i += 1) {
    const r = await api('POST', '/api/login', { password: 'esta-no-es' });
    status = r.status;
  }
  assert.equal(status, 429);
});

test('una ruta /api desconocida da 404 JSON', async () => {
  const r = await api('GET', '/api/esta-no-existe');
  assert.equal(r.status, 404);
});