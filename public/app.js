const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

let CONFIG = null;
let horaSel = null;
let ABIERTO = true;
const MIS_KEY = 'barberia_mis_citas';

// ---------- utilidades ----------
function fechaLocal(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d);
}

function fechaLarga(iso) {
  return fechaLocal(iso).toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function hoyISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function mostrarError(msg) {
  const el = $('error');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- apariencia configurable ----------
function aplicarApariencia(c) {
  const col = (c && c.colores) || {};
  const raiz = document.documentElement;
  const hex = (v, alt) => (/^#[0-9a-fA-F]{3,8}$/.test(v || '') ? v : alt);
  raiz.style.setProperty('--gold', hex(col.principal, '#f2b544'));
  raiz.style.setProperty('--gold-dark', hex(col.principalOscuro, '#d99e2c'));
  raiz.style.setProperty('--bg', hex(col.fondo, '#0e1013'));

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', hex(col.tema, '#0e1013'));

  if (c && c.logo) $('logo').textContent = c.logo;
  if (c && typeof c.tagline === 'string') $('tagline').textContent = c.tagline;
}

// ---------- textos configurables ----------
function aplicarTextos(c) {
  const t = (c && c.textos) || {};
  const set = (id, val, def) => { const el = $(id); if (el) el.textContent = val || def; };
  set('shopName', c && c.shopName, 'Barbería');
  document.title = `Reservar cita · ${(c && c.shopName) || 'Barbería'}`;
  set('labelNombre', t.etiquetaNombre, '1. Tu nombre');
  set('labelTelefono', t.etiquetaTelefono, '2. Número de teléfono');
  set('labelFecha', t.etiquetaFecha, '3. Fecha de la cita');
  set('labelHora', t.etiquetaHora, '4. Hora');
  set('labelServicio', t.etiquetaServicio, '5. ¿Qué te vas a hacer?');
  set('okTitulo', t.tituloConfirmacion, '¡Cita reservada!');
  set('okTexto', t.subtituloConfirmacion, 'Te esperamos. Guarda estos datos.');
  const btn = $('submit');
  if (btn && ABIERTO) btn.textContent = t.botonReservar || 'Reservar cita';
  const btnMis = $('btnMis');
  if (btnMis) btnMis.textContent = t.botonMisCitas || '📋 Ver / cancelar mis citas';
}

function textoBotonReservar() {
  return (CONFIG && CONFIG.textos && CONFIG.textos.botonReservar) || 'Reservar cita';
}

// ---------- estado abierto / cerrado del local ----------
function aplicarEstado() {
  const box = $('cerradoBox');
  const btn = $('submit');
  if (!box || !btn) return;
  if (ABIERTO) {
    box.hidden = true;
    btn.disabled = false;
    btn.textContent = textoBotonReservar();
  } else {
    box.hidden = false;
    btn.disabled = true;
    btn.textContent = 'Cerrado · no se puede reservar';
  }
}

async function refrescarEstado() {
  try {
    const r = await fetch('/api/estado');
    ABIERTO = (await r.json()).abierto === true;
  } catch {}
  aplicarEstado();
}

// ---------- carga inicial ----------
async function init() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
  } catch {
    mostrarError('No se pudo conectar con el servidor.');
    return;
  }

  $('shopName').textContent = CONFIG.shopName;
  document.title = `Reservar cita · ${CONFIG.shopName}`;
  ABIERTO = CONFIG.abierto !== false;
  aplicarEstado();

  aplicarApariencia(CONFIG);
  aplicarTextos(CONFIG);

  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const abiertos = CONFIG.diasAbiertos.map((d) => dias[d]);
  const rango = abiertos.length === 1 ? abiertos[0] : `${abiertos[0]} a ${abiertos[abiertos.length - 1]}`;
  $('horario').textContent =
    `${CONFIG.shopName} · ${rango} de ${CONFIG.horas[0]} a ${CONFIG.horas[CONFIG.horas.length - 1]}` +
    (CONFIG.footer ? ` · ${CONFIG.footer}` : '');

  const sel = $('servicio');
  CONFIG.servicios.forEach((s) => {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  });

  const fecha = $('fecha');
  fecha.min = hoyISO();
  const max = new Date();
  max.setDate(max.getDate() + 60);
  fecha.max = max.toISOString().slice(0, 10);
  fecha.value = hoyISO();

  fecha.addEventListener('change', cargarHoras);
  sel.addEventListener('change', () => {
    $('servicioOtro').hidden = sel.value !== 'Otro';
    if (sel.value === 'Otro') $('servicioOtro').focus();
  });

  await cargarHoras();
  setInterval(refrescarEstado, 60 * 1000);
}

// ---------- horas disponibles ----------
async function cargarHoras() {
  horaSel = null;
  const cont = $('slots');
  const info = $('slotsInfo');
  const fecha = $('fecha').value;
  if (!fecha) return;

  cont.innerHTML = '<div class="muted" style="grid-column:1/-1">Cargando…</div>';
  info.textContent = '';

  try {
    const r = await fetch(`/api/slots?fecha=${fecha}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error');

    cont.innerHTML = '';

    if (data.cerrado) {
      cont.innerHTML = '<div class="muted" style="grid-column:1/-1">Ese día no estamos abiertos. Elige otra fecha.</div>';
      return;
    }

    const libres = data.horas.filter((h) => h.disponible).length;
    info.textContent = libres ? `${libres} horas disponibles` : '';

    if (!libres) {
      cont.innerHTML = '<div class="muted" style="grid-column:1/-1">No quedan horas libres ese día. Prueba con otra fecha.</div>';
      return;
    }

    data.horas.forEach((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot' + (h.disponible ? '' : ' off');
      b.textContent = h.hora;
      b.disabled = !h.disponible;
      if (h.disponible) {
        b.addEventListener('click', () => {
          cont.querySelectorAll('.slot').forEach((s) => s.classList.remove('sel'));
          b.classList.add('sel');
          horaSel = h.hora;
          mostrarError('');
        });
      }
      cont.appendChild(b);
    });
  } catch (e) {
    cont.innerHTML = `<div class="muted" style="grid-column:1/-1">${e.message}</div>`;
  }
}

// ---------- reserva ----------
on('form', 'submit', async (e) => {
  e.preventDefault();
  mostrarError('');

  if (!ABIERTO) return mostrarError('La barbería está cerrada por ahora. Vuelve más tarde.');

  const nombre = $('nombre').value.trim();
  let telLocal = $('telefono').value.replace(/\D/g, '');
  if (telLocal.length === 11 && telLocal.startsWith('1')) telLocal = telLocal.slice(1);
  const telefono = '1' + telLocal;
  const fecha = $('fecha').value;
  const servicio = $('servicio').value;
  const servicioFinal = servicio === 'Otro' ? $('servicioOtro').value.trim() : servicio;

  if (nombre.length < 3) return mostrarError('Escribe tu nombre completo.');
  if (telLocal.length < 7 || telLocal.length > 12) return mostrarError('Escribe un número de teléfono válido (10 dígitos).');
  if (!fecha) return mostrarError('Elige la fecha de tu cita.');
  if (!horaSel) return mostrarError('Elige la hora de tu cita.');
  if (!servicio) return mostrarError('Elige qué te vas a hacer.');
  if (servicio === 'Otro' && !servicioFinal) return mostrarError('Describe el servicio que necesitas.');

  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Reservando…';

  try {
    const r = await fetch('/api/citas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre,
        telefono,
        fecha,
        hora: horaSel,
        servicio: servicioFinal,
        notas: $('notas').value.trim(),
      }),
    });
    const data = await r.json();

    if (!r.ok) {
      mostrarError(data.error || 'No se pudo reservar. Intenta de nuevo.');
      if (r.status === 409) await cargarHoras();
      return;
    }

    agregarMi(data.cita);
    mostrarConfirmacion(data.cita);
  } catch {
    mostrarError('Sin conexión. Revisa tu internet e intenta de nuevo.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reservar cita';
  }
});

function mostrarConfirmacion(cita) {
  const filas = [
    ['Nombre', cita.nombre],
    ['Teléfono', cita.telefono],
    ['Fecha', fechaLarga(cita.fecha)],
    ['Hora', cita.hora],
    ['Servicio', cita.servicio],
  ];
  if (cita.notas) filas.push(['Comentario', cita.notas]);

  $('ticket').innerHTML = filas
    .map(([k, v]) => `<div class="row"><span>${k}</span><span>${escapeHtml(String(v))}</span></div>`)
    .join('');

  const btnWa = $('btnWa');
  if (CONFIG.whatsapp) {
    const msg =
      `Hola 👋, soy ${cita.nombre} y acabo de reservar una cita en ${CONFIG.shopName}: ` +
      `${fechaLarga(cita.fecha)} a las ${cita.hora} — ${cita.servicio}. Tel: ${cita.telefono}`;
    btnWa.href = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(msg)}`;
    btnWa.hidden = false;
  } else {
    btnWa.hidden = true;
  }

  $('formView').hidden = true;
  $('okView').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

on('btnOtra', 'click', () => {
  $('form').reset();
  horaSel = null;
  $('servicioOtro').hidden = true;
  $('fecha').value = hoyISO();
  mostrarError('');
  $('okView').hidden = true;
  $('formView').hidden = false;
  cargarHoras();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- mis citas (guarda el id localmente) ----------
function leerMis() {
  try { return JSON.parse(localStorage.getItem(MIS_KEY)) || []; } catch { return []; }
}

function guardarMis(lista) {
  try { localStorage.setItem(MIS_KEY, JSON.stringify(lista.slice(-20))); } catch {}
}

function agregarMi(cita) {
  const lista = leerMis().filter((c) => c.id !== cita.id);
  lista.push({
    id: cita.id,
    telefono: cita.telefono,
    nombre: cita.nombre,
    fecha: cita.fecha,
    hora: cita.hora,
    servicio: cita.servicio,
  });
  guardarMis(lista);
}

async function renderMis() {
  const cont = $('misLista');
  const lista = leerMis();
  if (!lista.length) {
    cont.innerHTML = '<p class="muted">Aún no tienes citas reservadas en este dispositivo.</p>';
    return;
  }
  cont.innerHTML = '<p class="muted">Cargando…</p>';
  const resultados = await Promise.all(
    lista.map(async (c) => {
      try {
        const r = await fetch(`/api/citas/mia?id=${c.id}&telefono=${encodeURIComponent(c.telefono)}`);
        if (r.status === 404) return { ...c, estado: 'no encontrada' };
        if (!r.ok) return { ...c, estado: '?' };
        return { ...c, ...(await r.json()) };
      } catch {
        return { ...c, estado: '?' };
      }
    })
  );
  cont.innerHTML = '';
  resultados.forEach((c) => cont.appendChild(tarjetaMis(c)));
}

function tarjetaMis(c) {
  const art = document.createElement('article');
  art.className = 'miscita';

  let badge;
  if (c.estado === 'no encontrada') badge = '<span class="badge cancelada">eliminada</span>';
  else if (!c.estado || c.estado === '?') badge = '<span class="badge cancelada">sin conexión</span>';
  else badge = `<span class="badge ${escapeHtml(c.estado)}">${escapeHtml(c.estado)}</span>`;

  art.innerHTML = `
    <div class="head">
      <div>
        <div class="cuando">${escapeHtml(fechaLarga(c.fecha))} · ${escapeHtml(c.hora)}</div>
        <div class="detalle">✂️ ${escapeHtml(c.servicio)}${c.nombre ? ` · ${escapeHtml(c.nombre)}` : ''}</div>
      </div>
      ${badge}
    </div>`;

  const puedeCancelar =
    (c.estado === 'pendiente' || c.estado === 'confirmada') && c.fecha >= hoyISO();
  if (puedeCancelar) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn danger';
    b.textContent = 'Cancelar esta cita';
    b.addEventListener('click', () => cancelarMi(c.id));
    art.appendChild(b);
  }
  return art;
}

async function cancelarMi(id) {
  if (!confirm('¿Seguro que quieres cancelar esta cita?')) return;
  const cita = leerMis().find((c) => c.id === id);
  if (!cita) return;
  try {
    const r = await fetch(`/api/citas/${id}/cancelar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono: cita.telefono }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return mostrarError(data.error || 'No se pudo cancelar la cita.');
    await renderMis();
    await cargarHoras();
  } catch {
    mostrarError('Sin conexión. Revisa tu internet e intenta de nuevo.');
  }
}

on('btnMis', 'click', async () => {
  const box = $('misBox');
  box.hidden = !box.hidden;
  $('btnMis').textContent = box.hidden
    ? '📋 Ver / cancelar mis citas'
    : '📋 Ocultar mis citas';
  if (!box.hidden) await renderMis();
});

init();
