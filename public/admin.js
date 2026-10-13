const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const KEY = 'barberia_admin_token';

let TOKEN = localStorage.getItem(KEY) || null;
let CONFIG = null;
let vista = 'fecha'; // 'fecha' | 'todas'
let busqueda = '';
let debounceBusqueda = null;

// Avisos de citas próximas
const AVISO_MIN = 15; // minutos de anticipación
const NOTIF_KEY = 'barberia_notificadas';
const ULTIMO_KEY = 'barberia_ultimo_id';
let ABIERTO = true;

// ---------- apariencia y textos configurables ----------
function aplicarApariencia(c) {
  const col = (c && c.colores) || {};
  const raiz = document.documentElement;
  const hex = (v, alt) => (/^#[0-9a-fA-F]{3,8}$/.test(v || '') ? v : alt);
  raiz.style.setProperty('--gold', hex(col.principal, '#f2b544'));
  raiz.style.setProperty('--gold-dark', hex(col.principalOscuro, '#d99e2c'));
  raiz.style.setProperty('--bg', hex(col.fondo, '#0e1013'));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', hex(col.tema, '#0e1013'));
  const t = (c && c.textos) || {};
  const set = (id, val, def) => { const el = $(id); if (el) el.textContent = val || def; };
  set('loginLogo', c && c.logoPanel, '💈');
  set('logoPanel', c && c.logoPanel, '💈');
  set('loginTitulo', t.tituloPanel, 'Panel del barbero');
  set('loginSubtitulo', t.subtituloLogin, 'Acceso restringido');
  if (c && c.shopName) {
    $('shopName').textContent = c.shopName;
    document.title = `Panel · ${c.shopName}`;
    $('foot').textContent = `${c.shopName} · panel de citas`;
  }
}

// ---------- utilidades ----------
function hoyISO() {  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function fechaLarga(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Muestra una notificación de forma compatible con todos los navegadores.
// En Android Chrome el constructor `new Notification` no existe: hay que usar
// el service worker (showNotification). En escritorio sirve cualquiera.
async function mostrarNotificacion(titulo, opciones = {}) {
  if (!('Notification' in window)) return;
  const opts = { icon: '/icon-192.png', badge: '/icon-192.png', ...opciones };
  if ('serviceWorker' in navigator) {
    try {
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((res) => setTimeout(() => res(null), 2500)),
        ]);
      }
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(titulo, opts);
        return;
      }
    } catch {}
  }
  try { new Notification(titulo, opts); } catch (e) { console.warn('Notificación no soportada:', e.message); }
}

async function api(url, opciones = {}) {
  const r = await fetch(url, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(opciones.headers || {}),
      Authorization: `Bearer ${TOKEN}`,
    },
  });
  if (r.status === 401) {
    salir();
    throw new Error('Sesión expirada. Entra de nuevo.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Error en el servidor');
  return data;
}

// ---------- login ----------
async function entrar() {
  const password = $('password').value;
  if (!password) return mostrarLoginError('Escribe la contraseña.');
  const btn = $('btnLogin');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Contraseña incorrecta.');
    TOKEN = data.token;
    localStorage.setItem(KEY, TOKEN);
    mostrarLoginError('');
    abrirPanel();
  } catch (e) {
    mostrarLoginError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

function mostrarLoginError(msg) {
  const el = $('loginError');
  el.hidden = !msg;
  el.textContent = msg || '';
}

function salir() {
  TOKEN = null;
  localStorage.removeItem(KEY);
  if (avisosTimer) { clearInterval(avisosTimer); avisosTimer = null; }
  $('panelView').hidden = true;
  $('loginView').hidden = false;
}

async function abrirPanel() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
  } catch {
    return;
  }
  $('shopName').textContent = CONFIG.shopName;
  document.title = `Panel · ${CONFIG.shopName}`;
  $('foot').textContent = `${CONFIG.shopName} · panel de citas`;
  aplicarApariencia(CONFIG);
  $('loginView').hidden = true;
  $('panelView').hidden = false;
  $('fecha').value = hoyISO();
  pintarBtnAvisos();
  await cargarEstado();
  await revisarNuevas();
  await cargar();
  iniciarAvisos();
}

// ---------- estado abierto / cerrado ----------
async function cargarEstado() {
  try {
    const r = await fetch('/api/estado');
    ABIERTO = (await r.json()).abierto;
  } catch {}
  pintarEstado();
}

function pintarEstado() {
  const b = $('btnEstado');
  if (!b) return;
  b.textContent = ABIERTO
    ? '🟢 Abierto · recibiendo citas'
    : '🔴 Cerrado · no laborando';
  b.classList.toggle('abierto', ABIERTO);
  b.classList.toggle('cerrado', !ABIERTO);
}

async function toggleEstado() {
  const nuevo = !ABIERTO;
  try {
    await api('/api/admin/estado', { method: 'POST', body: JSON.stringify({ abierto: nuevo }) });
    ABIERTO = nuevo;
    pintarEstado();
  } catch (e) {
    alert(e.message);
  }
}

// ---------- avisos de citas próximas ----------
function pintarBtnAvisos() {
  const b = $('btnAvisos');
  if (!b) return;
  if (!('Notification' in window)) { b.hidden = true; return; }
  b.hidden = false;
  if (Notification.permission === 'granted') {
    b.textContent = '🔔 Avisos activados';
    b.classList.add('on');
  } else {
    b.textContent = '🔔 Activar avisos';
    b.classList.remove('on');
  }
}

async function activarAvisos() {
  if (!('Notification' in window)) {
    alert('Este navegador no soporta notificaciones.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    pintarBtnAvisos();
    if (perm === 'granted') {
      await mostrarNotificacion('Avisos activados 💈', {
        body: `Te avisaré ${AVISO_MIN} min antes de cada cita y de cada reserva nueva.`,
      });
    } else if (perm === 'denied') {
      alert('Bloqueaste las notificaciones. Actívalas en los ajustes del navegador/sistema.');
    }
  } catch (e) {
    alert(e.message);
  }
}

function leerNotificadas() {
  try {
    const hoy = hoyISO();
    const datos = JSON.parse(localStorage.getItem(NOTIF_KEY)) || {};
    return datos.fecha === hoy ? (datos.ids || []) : [];
  } catch {
    return [];
  }
}

function marcarNotificada(id) {
  const ids = leerNotificadas();
  ids.push(id);
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify({ fecha: hoyISO(), ids: ids.slice(-200) })); } catch {}
}

function minutosHastaCita(c) {
  return (new Date(`${c.fecha}T${c.hora}:00`).getTime() - Date.now()) / 60000;
}

function revisarAvisos(citas) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const ya = leerNotificadas();
  citas
    .filter((c) => (c.estado === 'pendiente' || c.estado === 'confirmada') && !ya.includes(c.id))
    .forEach((c) => {
      const min = minutosHastaCita(c);
      if (min <= AVISO_MIN && min > -1) {
        mostrarNotificacion(`💈 Cita en ${Math.max(0, Math.round(min))} min`, {
          body: `${c.hora} · ${c.nombre} · ${c.servicio}${c.notas ? `\n📝 ${c.notas}` : ''}`,
          tag: `cita-${c.id}`,
          renotify: true,
        });
        marcarNotificada(c.id);
      }
    });
}

let avisosTimer = null;
function iniciarAvisos() {
  if (avisosTimer) clearInterval(avisosTimer);
  avisosTimer = setInterval(() => {
    if (!TOKEN) return;
    revisarNuevas();
    cargar();
  }, 45 * 1000);
}

// ---------- aviso de nuevas reservas ----------
function leerUltimoId() {
  const v = parseInt(localStorage.getItem(ULTIMO_KEY), 10);
  return Number.isInteger(v) ? v : null;
}

function setUltimoId(v) {
  try { localStorage.setItem(ULTIMO_KEY, String(v)); } catch {}
}

async function revisarNuevas() {
  const desde = leerUltimoId();
  try {
    const data = await api(`/api/admin/nuevas${desde !== null ? `?desde=${desde}` : ''}`);
    if (desde !== null && data.citas.length) {
      data.citas.forEach(notificarNueva);
    }
    setUltimoId(data.maxId);
  } catch {}
}

function notificarNueva(c) {
  const resumen = `${fechaLarga(c.fecha)} a las ${c.hora}`;
  if ('Notification' in window && Notification.permission === 'granted') {
    mostrarNotificacion('💈 Nueva cita reservada', {
      body: `${c.nombre} · ${c.servicio}\n${resumen}\n📞 ${c.telefono}${c.notas ? `\n📝 ${c.notas}` : ''}`,
      tag: `nueva-${c.id}`,
      renotify: true,
    });
  }
  // Aviso también dentro de la app (si está despierta pero sin permiso de notificaciones)
  if (!document.hidden && $('chips')) {
    $('chips').insertAdjacentHTML(
      'afterend',
      `<div class="aviso-nueva">💈 Nueva cita: ${escapeHtml(c.nombre)} · ${escapeHtml(c.servicio)} · ${escapeHtml(resumen)}</div>`
    );
    setTimeout(() => {
      const el = document.querySelector('.aviso-nueva');
      if (el) el.remove();
    }, 12000);
  }
}

// ---------- carga de citas ----------
async function cargar() {
  const lista = $('lista');
  lista.innerHTML = '<div class="empty"><span class="big">⏳</span>Cargando…</div>';

  try {
    const q = vista === 'todas' ? 'todas' : $('fecha').value;
    let url = `/api/admin/citas?fecha=${q}`;
    if (busqueda) url += `&q=${encodeURIComponent(busqueda)}`;
    const data = await api(url);
    render(data.citas);
    revisarAvisos(data.citas);
  } catch (e) {
    lista.innerHTML = `<div class="empty"><span class="big">⚠️</span>${escapeHtml(e.message)}</div>`;
  }
}

function render(citas) {
  const lista = $('lista');

  // Chips resumen
  const hoy = hoyISO();
  const cuenta = (est) => citas.filter((c) => c.estado === est).length;
  const deHoy = citas.filter((c) => c.fecha === hoy && c.estado !== 'cancelada').length;
  $('chips').innerHTML = `
    <span class="chip">Total <b>${citas.length}</b></span>
    <span class="chip">Hoy <b>${deHoy}</b></span>
    <span class="chip">Pendientes <b>${cuenta('pendiente')}</b></span>
    <span class="chip">Confirmadas <b>${cuenta('confirmada')}</b></span>
    <span class="chip">Completadas <b>${cuenta('completada')}</b></span>
    <span class="chip">Canceladas <b>${cuenta('cancelada')}</b></span>`;

  // Próxima cita sin cancelar
  const ahora = new Date().getTime();
  const proximas = citas
    .filter((c) => c.estado !== 'cancelada' && new Date(`${c.fecha}T${c.hora}:00`).getTime() > ahora)
    .sort((a, b) => `${a.fecha}T${a.hora}`.localeCompare(`${b.fecha}T${b.hora}`));
  $('proxima').textContent = proximas.length
    ? `⏭ Próxima: ${fechaLarga(proximas[0].fecha)} a las ${proximas[0].hora} · ${proximas[0].nombre} (${proximas[0].servicio})`
    : '';

  if (!citas.length) {
    lista.innerHTML = '<div class="empty"><span class="big">📅</span>No hay citas en esta vista.</div>';
    return;
  }

  // Agrupa por fecha cuando se ven todas
  let html = '';
  let fechaActual = '';
  citas.forEach((c) => {
    if (vista === 'todas' && c.fecha !== fechaActual) {
      fechaActual = c.fecha;
      html += `<div class="chip" style="margin:6px 0 12px;display:inline-block">📅 ${escapeHtml(fechaLarga(c.fecha))}</div>`;
    }
    html += tarjeta(c);
  });
  lista.innerHTML = html;
  lista.querySelectorAll('[data-accion]').forEach((btn) => {
    btn.addEventListener('click', () => accion(btn.dataset.accion, Number(btn.dataset.id)));
  });
}

function tarjeta(c) {
  const tel = c.telefono;
  const msg = mensaje(c);
  const wa = `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`;

  const acciones = [];
  if (c.estado === 'pendiente') acciones.push(`<button class="ok" data-accion="confirmada" data-id="${c.id}">✓ Confirmar</button>`);
  if (c.estado === 'pendiente' || c.estado === 'confirmada') acciones.push(`<button class="warn" data-accion="completada" data-id="${c.id}">✓✓ Completar</button>`);
  if (c.estado !== 'cancelada' && c.estado !== 'completada') acciones.push(`<button class="bad" data-accion="cancelada" data-id="${c.id}">✕ Cancelar</button>`);
  acciones.push(`<button class="wa" onclick="window.open('${wa}','_blank')">📱 WhatsApp</button>`);
  acciones.push(`<button class="bad" data-accion="eliminar" data-id="${c.id}">🗑</button>`);

  return `
    <article class="cita">
      <div class="head">
        <div>
          <div class="hora">${c.hora}</div>
          <div class="nombre">${escapeHtml(c.nombre)}</div>
          <div class="meta">📞 <a href="tel:${tel}" style="color:inherit">${escapeHtml(tel)}</a> · ✂️ ${escapeHtml(c.servicio)}</div>
          ${c.notas ? `<div class="meta">📝 ${escapeHtml(c.notas)}</div>` : ''}
        </div>
        <span class="badge ${c.estado}">${c.estado}</span>
      </div>
      <div class="actions">${acciones.join('')}</div>
    </article>`;
}

function mensaje(c) {
  const fecha = fechaLarga(c.fecha);
  if (c.estado === 'confirmada') {
    return `Hola ${c.nombre}, te confirmo tu cita en ${CONFIG.shopName} el ${fecha} a las ${c.hora} (${c.servicio}). ¡Te esperamos! 💈`;
  }
  if (c.estado === 'completada') {
    return `Hola ${c.nombre}, gracias por tu visita a ${CONFIG.shopName}. ¡Que tengas un excelente día! 💈`;
  }
  if (c.estado === 'cancelada') {
    return `Hola ${c.nombre}, te informamos que tu cita del ${fecha} a las ${c.hora} ha sido cancelada. Si deseas reprogramar, escríbenos. 💈`;
  }
  return `Hola ${c.nombre}, recibimos tu solicitud de cita en ${CONFIG.shopName} para el ${fecha} a las ${c.hora} (${c.servicio}). Te confirmamos en breve. 💈`;
}

// ---------- acciones ----------
async function accion(estado, id) {
  if (estado === 'eliminar') {
    if (!confirm('¿Eliminar esta cita definitivamente?')) return;
    try {
      await api(`/api/admin/citas/${id}`, { method: 'DELETE' });
      await cargar();
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  // Al confirmar, abrimos WhatsApp de inmediato (antes del await) para que
  // el navegador no bloquee la pestaña por falta de gesto del usuario.
  let waWin = null;
  if (estado === 'confirmada') {
    try { waWin = window.open('', '_blank'); } catch {}
  }

  try {
    const res = await api(`/api/admin/citas/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado }),
    });
    await cargar();
    if (estado === 'confirmada' && res.cita) {
      const wa = `https://wa.me/${res.cita.telefono}?text=${encodeURIComponent(mensaje(res.cita))}`;
      if (waWin) waWin.location.href = wa;
      else window.open(wa, '_blank');
    }
  } catch (e) {
    if (waWin) waWin.close();
    alert(e.message);
  }
}

// ---------- eventos ----------
on('btnLogin', 'click', entrar);
on('password', 'keydown', (e) => { if (e.key === 'Enter') entrar(); });
on('btnLogout', 'click', salir);
on('btnEstado', 'click', toggleEstado);
on('btnAvisos', 'click', activarAvisos);
on('fecha', 'change', () => { vista = 'fecha'; cargar(); });
on('btnHoy', 'click', () => { vista = 'fecha'; $('fecha').value = hoyISO(); cargar(); });
on('btnTodas', 'click', () => { vista = 'todas'; cargar(); });
on('buscar', 'input', () => {
  clearTimeout(debounceBusqueda);
  debounceBusqueda = setTimeout(() => {
    busqueda = $('buscar').value.trim();
    cargar();
  }, 300);
});

// ---------- exportar / importar / estadísticas ----------
async function exportar() {
  try {
    const r = await fetch('/api/admin/export', { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error('No se pudo exportar.');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `citas-${hoyISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    alert(e.message);
  }
}

async function importarArchivo(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('El archivo no es un JSON válido.');
    return;
  }
  const ok = confirm('¿Importar las citas de este archivo? Las coincidentes se omiten (no se duplican).');
  if (!ok) return;
  try {
    const r = await api('/api/admin/import', { method: 'POST', body: JSON.stringify(data) });
    alert(`Importadas: ${r.importadas}, omitidas: ${r.omitidas}.`);
    await cargar();
  } catch (e) {
    alert(e.message);
  }
}

async function cargarStats() {
  const box = $('statsBox');
  box.hidden = !box.hidden;
  $('btnStats').textContent = box.hidden
    ? '📊 Estadísticas'
    : '📊 Ocultar estadísticas';
  if (box.hidden) return;
  box.innerHTML = '<div class="card"><p class="muted">Cargando…</p></div>';
  try {
    const s = await api('/api/admin/stats');
    const filasDia = s.porDia.map(
      (d) =>
        `<tr><td>${escapeHtml(fechaLarga(d.fecha))}</td><td>${d.total}</td><td class="bad">${d.canceladas}</td></tr>`
    ).join('');
    const filasSrv = s.servicios
      .map((x) => `<span class="chip">${escapeHtml(x.servicio)} <b>${x.c}</b></span>`)
      .join('');
    const pend = s.porEstado.pendiente || 0;
    const conf = s.porEstado.confirmada || 0;
    const comp = s.porEstado.completada || 0;
    const canc = s.porEstado.cancelada || 0;
    box.innerHTML = `
      <div class="card">
        <div class="chips" style="margin-bottom:8px">
          <span class="chip">Total <b>${s.total}</b></span>
          <span class="chip">Pendientes <b>${pend}</b></span>
          <span class="chip">Confirmadas <b>${conf}</b></span>
          <span class="chip">Completadas <b>${comp}</b></span>
          <span class="chip">Canceladas <b>${canc}</b></span>
        </div>
        ${filasSrv ? `<div style="margin-bottom:10px">${filasSrv}</div>` : ''}
        <table class="stats">
          <thead><tr><th>Día</th><th>Citas</th><th>Canceladas</th></tr></thead>
          <tbody>${filasDia || '<tr><td colspan="3" class="muted">Sin datos todavía.</td></tr>'}</tbody>
        </table>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="card"><p class="error">${escapeHtml(e.message)}</p></div>`;
  }
}

on('btnExport', 'click', exportar);
on('btnImport', 'click', () => { const f = $('fileImport'); if (f) f.click(); });
on('fileImport', 'change', async (e) => {
  const f = e.target.files && e.target.files[0];
  await importarArchivo(f || null);
  e.target.value = '';
});
on('btnStats', 'click', cargarStats);

// ---------- arranque ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(async function inicio() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
    aplicarApariencia(CONFIG);
  } catch {}
  if (TOKEN) {
    await abrirPanel();
  }
})();
