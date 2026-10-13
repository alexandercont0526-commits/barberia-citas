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
process.env.DEV_PASSWORD = '0526';
process.env.MAX_CITAS_POR_DIA = '3';

const app = require('../server.js');

let server;
let base;
let TOKEN = null;
let DEV_TOKEN = null;

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

test('dev config exige token', async () => {
  const r = await api('GET', '/api/dev/config');
  assert.equal(r.status, 401);
});

test('dev login con contraseña incorrecta da 401', async () => {
  const r = await api('POST', '/api/dev/login', { password: 'incorrecta' });
  assert.equal(r.status, 401);
});

test('dev login correcto entrega token de desarrollador', async () => {
  const r = await api('POST', '/api/dev/login', { password: '0526' });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  DEV_TOKEN = r.body.token;
});

test('el token del panel NO sirve para la sección de desarrollador', async () => {
  const r = await api('GET', '/api/dev/config', undefined, TOKEN);
  assert.equal(r.status, 401);
});

test('el token de desarrollador NO sirve en el panel', async () => {
  const r = await api('GET', '/api/admin/citas?fecha=todas', undefined, DEV_TOKEN);
  assert.equal(r.status, 401);
});

test('dev config no expone los hashes de contraseña', async () => {
  const r = await api('GET', '/api/dev/config', undefined, DEV_TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.body.passwordHash, undefined);
  assert.equal(r.body.devPasswordHash, undefined);
  assert.equal(r.body.tienePassword, false);
});

test('dev config actualiza identidad y servicios', async () => {
  const r = await api(
    'PUT',
    '/api/dev/config',
    { shopName: 'Barber Pro', servicios: ['Corte', 'Barba'], colores: { principal: '#ff0000' } },
    DEV_TOKEN
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.config.shopName, 'Barber Pro');
  assert.deepEqual(r.body.config.servicios, ['Corte', 'Barba']);
  assert.equal(r.body.config.colores.principal, '#ff0000');

  const pub = await api('GET', '/api/config');
  assert.equal(pub.body.shopName, 'Barber Pro');
  assert.deepEqual(pub.body.servicios, ['Corte', 'Barba']);
});

test('dev config ignora passwordHash entrante', async () => {
  await api('PUT', '/api/dev/config', { passwordHash: 'malicioso' }, DEV_TOKEN);
  const r = await api('GET', '/api/dev/config', undefined, DEV_TOKEN);
  assert.equal(r.body.tienePassword, false);
});

test('dev cambia la contraseña del panel y rechaza la anterior', async () => {
  const cambio = await api(
    'POST',
    '/api/dev/password',
    { actual: 'testpass123', nueva: 'nueva6789' },
    DEV_TOKEN
  );
  assert.equal(cambio.status, 200);

  const vieja = await api('POST', '/api/login', { password: 'testpass123' });
  assert.equal(vieja.status, 401);

  const nueva = await api('POST', '/api/login', { password: 'nueva6789' });
  assert.equal(nueva.status, 200);
  assert.ok(nueva.body.token);
  TOKEN = nueva.body.token;
});

test('dev cambia la contraseña de desarrollador NO está disponible (404)', async () => {
  const r = await api(
    'POST',
    '/api/dev/password-dev',
    { actual: '0526', nueva: 'dev9876' },
    DEV_TOKEN
  );
  assert.equal(r.status, 404);
});

test('restablecer todo conserva la contraseña del panel', async () => {
  const r = await api('POST', '/api/dev/config/reset', { grupo: 'todo' }, DEV_TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.body.config.tienePassword, true);

  const siguePanel = await api('POST', '/api/login', { password: 'nueva6789' });
  assert.equal(siguePanel.status, 200);
  TOKEN = siguePanel.body.token;

  const sigueDev = await api('POST', '/api/dev/login', { password: '0526' });
  assert.equal(sigueDev.status, 200);
  DEV_TOKEN = sigueDev.body.token;
});

test('dev cambia la contraseña con una incorrecta da 401', async () => {
  const r = await api('POST', '/api/dev/password', { actual: 'no-es', nueva: 'otra123' }, DEV_TOKEN);
  assert.equal(r.status, 401);
});

test('dev sube y borra iconos', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const subida = await api(
    'POST',
    '/api/dev/icono',
    { icon192: `data:image/png;base64,${png}`, icon512: `data:image/png;base64,${png}` },
    DEV_TOKEN
  );
  assert.equal(subida.status, 200);
  assert.ok(subida.body.guardados.includes('192'));

  const borrado = await api('DELETE', '/api/dev/icono', undefined, DEV_TOKEN);
  assert.equal(borrado.status, 200);
});

test('dev subir iconos sin imagen válida da 400', async () => {
  const r = await api('POST', '/api/dev/icono', { icon192: 'no-es-imagen' }, DEV_TOKEN);
  assert.equal(r.status, 400);
});

test('la página /dev se sirve como HTML', async () => {
  const res = await fetch(`${base}/dev`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('dev.js'));
});

test('el manifest usa el nombre configurado', async () => {
  const r = await api('GET', '/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.ok(r.body.icons.length >= 2);
});

test('la config pública NO expone los ajustes de WhatsApp', async () => {
  const r = await api('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal('openwa' in r.body, false);
  assert.equal(JSON.stringify(r.body).includes('apiKey'), false);
});

test('el token del panel NO sirve para los endpoints de WhatsApp de dev', async () => {
  const r = await api('GET', '/api/dev/whatsapp', undefined, TOKEN);
  assert.equal(r.status, 401);
});

test('dev whatsapp sin configurar informa que falta configuración', async () => {
  const r = await api('GET', '/api/dev/whatsapp', undefined, DEV_TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.body.configurado, false);
});

test('dev whatsapp probar sin configurar da 400', async () => {
  const r = await api('POST', '/api/dev/whatsapp/probar', { numero: '584121234567' }, DEV_TOKEN);
  assert.equal(r.status, 400);
});

test('dev whatsapp probar con número inválido da 400', async () => {
  const r = await api('POST', '/api/dev/whatsapp/probar', { numero: '12' }, DEV_TOKEN);
  assert.equal(r.status, 400);
});

test('dev whatsapp iniciar sin configurar da 400', async () => {
  const r = await api('POST', '/api/dev/whatsapp/iniciar', undefined, DEV_TOKEN);
  assert.equal(r.status, 400);
});

test('dev config guarda y devuelve el grupo openwa', async () => {
  await api(
    'PUT',
    '/api/dev/config',
    {
      openwa: {
        habilitado: true,
        url: 'http://localhost:2785',
        apiKey: 'clave-secreta',
        sesion: 'barberia',
        barberoNumero: '18097674597',
        confirmarCliente: false,
        plantillas: { confirmacion: 'Hola {nombre}, cita el {fecha} a las {hora}.' },
      },
    },
    DEV_TOKEN
  );
  const r = await api('GET', '/api/dev/config', undefined, DEV_TOKEN);
  assert.equal(r.body.openwa.url, 'http://localhost:2785');
  assert.equal(r.body.openwa.apiKey, 'clave-secreta');
  assert.equal(r.body.openwa.habilitado, true);
  assert.equal(r.body.openwa.confirmarCliente, false);
  assert.equal(r.body.openwa.plantillas.confirmacion, 'Hola {nombre}, cita el {fecha} a las {hora}.');
  // Volvemos a dejar WhatsApp sin configurar para no disparar red en el resto.
  await api('POST', '/api/dev/config/reset', { grupo: 'openwa' }, DEV_TOKEN);
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