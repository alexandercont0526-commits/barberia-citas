const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const KEY = 'barberia_admin_token';
let TOKEN = localStorage.getItem(KEY) || null;
let CONFIG = null;
const ICONO_LOTE = {}; // dataURLs generados antes de subir

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const TEXTOS = {
  etiquetaNombre: 'Etiqueta del nombre',
  etiquetaTelefono: 'Etiqueta del teléfono',
  etiquetaFecha: 'Etiqueta de la fecha',
  etiquetaHora: 'Etiqueta de la hora',
  etiquetaServicio: 'Etiqueta del servicio',
  botonReservar: 'Botón "Reservar cita"',
  botonMisCitas: 'Botón "Mis citas"',
  tituloConfirmacion: 'Título de confirmación',
  subtituloConfirmacion: 'Subtítulo de confirmación',
  tituloPanel: 'Título del panel',
  subtituloLogin: 'Subtítulo del acceso',
};

// ---------- utilidades ----------
function aviso(msg, esError) {
  const el = $('aviso');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('error', !!esError);
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(ruta, opciones = {}) {
  const headers = Object.assign({}, opciones.headers || {});
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (opciones.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(ruta, Object.assign({}, opciones, { headers }));
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401) { salir(); throw new Error(data.error || 'Sesión expirada.'); }
  if (!r.ok) throw new Error(data.error || 'Error del servidor.');
  return data;
}

function aplicarApariencia(c) {
  const col = (c && c.colores) || {};
  const hex = (v, alt) => (/^#[0-9a-fA-F]{3,8}$/.test(v || '') ? v : alt);
  const raiz = document.documentElement;
  raiz.style.setProperty('--gold', hex(col.principal, '#f2b544'));
  raiz.style.setProperty('--gold-dark', hex(col.principalOscuro, '#d99e2c'));
  raiz.style.setProperty('--bg', hex(col.fondo, '#0e1013'));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', hex(col.tema, '#0e1013'));
  if (c && c.shopName) $('shopName').textContent = c.shopName;
  if (c && c.logoPanel) $('loginLogo').textContent = c.logoPanel;
}

// ---------- login ----------
async function entrar() {
  const password = $('password').value;
  const err = $('loginError');
  err.hidden = true;
  try {
    const r = await fetch('/api/dev/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Contraseña incorrecta.');
    TOKEN = data.token;
    localStorage.setItem(KEY, TOKEN);
    await abrir();
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
  }
}

function salir() {
  localStorage.removeItem(KEY);
  TOKEN = null;
  $('devView').hidden = true;
  $('loginView').hidden = false;
}

on('btnLogin', 'click', entrar);
on('password', 'keydown', (e) => { if (e.key === 'Enter') entrar(); });
on('btnLogout', 'click', salir);

// ---------- pestañas ----------
on('tabs', 'click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === b));
  document.querySelectorAll('.tabpane').forEach((p) => {
    p.hidden = p.dataset.pane !== b.dataset.tab;
  });
});

// ---------- carga y pintado ----------
function pintarFormulario(c) {
  $('c_shopName').value = c.shopName || '';
  $('c_logo').value = c.logo || '';
  $('c_logoPanel').value = c.logoPanel || '';
  $('c_tagline').value = c.tagline || '';
  $('c_footer').value = c.footer || '';
  $('c_whatsapp').value = c.whatsapp || '';

  $('c_servicios').value = (c.servicios || []).join('\n');

  $('c_horaInicio').value = c.horaInicio || '';
  $('c_horaFin').value = c.horaFin || '';
  $('c_intervalo').value = c.intervalo || 30;
  $('c_minAnticipacion').value = c.minAnticipacion || 0;
  $('c_maxCitasPorDia').value = c.maxCitasPorDia || 0;
  pintarDias(c.diasAbiertos || []);

  const col = c.colores || {};
  $('c_colorPrincipal').value = col.principal || '#f2b544';
  $('c_colorPrincipalOscuro').value = col.principalOscuro || '#d99e2c';
  $('c_colorFondo').value = col.fondo || '#0e1013';
  $('c_colorTema').value = col.tema || '#0e1013';

  pintarTextos(c.textos || {});
  pintarWhatsApp(c.openwa || {});

  $('c_json').value = JSON.stringify(c, null, 2);
  $('passInfo').textContent = c.tienePassword
    ? 'El panel usa una contraseña personalizada.'
    : 'El panel usa la contraseña por defecto.';
  $('foot').textContent = `${c.shopName || 'Barbería'} · desarrollador`;
}

function pintarDias(activos) {
  const cont = $('c_diasAbiertos');
  cont.innerHTML = '';
  DIAS.forEach((nombre, i) => {
    const l = document.createElement('label');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = String(i);
    chk.checked = activos.includes(i);
    l.appendChild(chk);
    l.appendChild(document.createTextNode(nombre));
    cont.appendChild(l);
  });
}

function pintarTextos(textos) {
  const cont = $('c_textos');
  cont.innerHTML = '';
  for (const [clave, etiqueta] of Object.entries(TEXTOS)) {
    const l = document.createElement('label');
    l.className = 'field';
    l.innerHTML = `<span>${etiqueta}</span>`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 120;
    inp.dataset.texto = clave;
    inp.value = textos[clave] || '';
    l.appendChild(inp);
    cont.appendChild(l);
  }
}

function pintarWhatsApp(w) {
  $('c_waHabilitado').checked = !!w.habilitado;
  $('c_waUrl').value = w.url || '';
  $('c_waApiKey').value = w.apiKey || '';
  $('c_waSesion').value = w.sesion || '';
  $('c_waBarbero').value = w.barberoNumero || '';
  $('c_waAvisoBarbero').checked = w.avisoBarbero !== false;
  $('c_waConfirmar').checked = w.confirmarCliente !== false;
  $('c_waRecordatorio').checked = w.recordatorioCliente !== false;
  $('c_waCancelacion').checked = w.avisoCancelacionCliente !== false;
  $('c_waRecordatorioHora').value = w.recordatorioHora || '18:00';
  const p = w.plantillas || {};
  $('c_plantNueva').value = p.nuevaCita || '';
  $('c_plantCancelBarbero').value = p.cancelacionBarbero || '';
  $('c_plantConfirmacion').value = p.confirmacion || '';
  $('c_plantRecordatorio').value = p.recordatorio || '';
  $('c_plantCancelCliente').value = p.cancelacion || '';
}

async function recargar() {
  CONFIG = await api('/api/dev/config');
  aplicarApariencia(CONFIG);
  pintarFormulario(CONFIG);
}

// ---------- guardar por grupos ----------
const GUARDAR = {
  identidad: () => ({
    shopName: $('c_shopName').value,
    logo: $('c_logo').value,
    logoPanel: $('c_logoPanel').value,
    tagline: $('c_tagline').value,
    footer: $('c_footer').value,
    whatsapp: $('c_whatsapp').value,
  }),
  servicios: () => ({
    servicios: $('c_servicios').value.split('\n').map((s) => s.trim()).filter(Boolean),
  }),
  horario: () => ({
    horaInicio: $('c_horaInicio').value,
    horaFin: $('c_horaFin').value,
    intervalo: $('c_intervalo').value,
    minAnticipacion: $('c_minAnticipacion').value,
    maxCitasPorDia: $('c_maxCitasPorDia').value,
    diasAbiertos: [...document.querySelectorAll('#c_diasAbiertos input:checked')].map((c) => Number(c.value)),
  }),
  apariencia: () => ({
    colores: {
      principal: $('c_colorPrincipal').value,
      principalOscuro: $('c_colorPrincipalOscuro').value,
      fondo: $('c_colorFondo').value,
      tema: $('c_colorTema').value,
    },
  }),
  textos: () => {
    const textos = {};
    document.querySelectorAll('#c_textos input[data-texto]').forEach((inp) => {
      textos[inp.dataset.texto] = inp.value;
    });
    return { textos };
  },
  whatsapp: () => ({
    openwa: {
      habilitado: $('c_waHabilitado').checked,
      url: $('c_waUrl').value.trim(),
      apiKey: $('c_waApiKey').value.trim(),
      sesion: $('c_waSesion').value.trim(),
      barberoNumero: $('c_waBarbero').value.trim(),
      avisoBarbero: $('c_waAvisoBarbero').checked,
      confirmarCliente: $('c_waConfirmar').checked,
      recordatorioCliente: $('c_waRecordatorio').checked,
      avisoCancelacionCliente: $('c_waCancelacion').checked,
      recordatorioHora: $('c_waRecordatorioHora').value || '18:00',
      plantillas: {
        nuevaCita: $('c_plantNueva').value,
        cancelacionBarbero: $('c_plantCancelBarbero').value,
        confirmacion: $('c_plantConfirmacion').value,
        recordatorio: $('c_plantRecordatorio').value,
        cancelacion: $('c_plantCancelCliente').value,
      },
    },
  }),
};

on('devView', 'click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const grupo = btn.dataset.save;
  btn.disabled = true;
  try {
    const r = await api('/api/dev/config', { method: 'PUT', body: JSON.stringify(GUARDAR[grupo]()) });
    CONFIG = r.config;
    aplicarApariencia(CONFIG);
    pintarFormulario(CONFIG);
    aviso('Cambios guardados.');
  } catch (err) {
    aviso(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

on('devView', 'click', async (e) => {
  const btn = e.target.closest('[data-reset]');
  if (!btn) return;
  const grupo = btn.dataset.reset;
  if (!confirm(grupo === 'todo' ? '¿Restablecer TODA la configuración de fábrica?' : '¿Restablecer este grupo?')) return;
  try {
    const r = await api('/api/dev/config/reset', { method: 'POST', body: JSON.stringify({ grupo }) });
    CONFIG = r.config;
    aplicarApariencia(CONFIG);
    pintarFormulario(CONFIG);
    aviso('Restablecido.');
  } catch (err) {
    aviso(err.message, true);
  }
});

// ---------- contraseña del panel ----------
on('btnPass', 'click', async () => {
  const actual = $('c_passActual').value;
  const nueva = $('c_passNueva').value;
  if (nueva.length < 4) return aviso('La nueva contraseña debe tener al menos 4 caracteres.', true);
  try {
    await api('/api/dev/password', { method: 'POST', body: JSON.stringify({ actual, nueva }) });
    $('c_passActual').value = '';
    $('c_passNueva').value = '';
    aviso('Contraseña del panel actualizada.');
    await recargar();
  } catch (err) {
    aviso(err.message, true);
  }
});

// ---------- iconos ----------
function cargarImagen(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function generar(img, tam) {
  const c = document.createElement('canvas');
  c.width = tam;
  c.height = tam;
  const ctx = c.getContext('2d');
  const lado = Math.min(img.width, img.height);
  const sx = (img.width - lado) / 2;
  const sy = (img.height - lado) / 2;
  ctx.drawImage(img, sx, sy, lado, lado, 0, 0, tam, tam);
  return c.toDataURL('image/png');
}

on('c_icono', 'change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return aviso('La imagen es muy grande (máx 8 MB).', true);
  try {
    const img = await cargarImagen(file);
    ICONO_LOTE.icon512 = generar(img, 512);
    ICONO_LOTE.icon192 = generar(img, 192);
    ICONO_LOTE.icon180 = generar(img, 180);
    ICONO_LOTE.favicon = ICONO_LOTE.icon192;
    $('prev512').src = ICONO_LOTE.icon512;
    $('prev192').src = ICONO_LOTE.icon192;
    $('prev180').src = ICONO_LOTE.icon180;
    $('prevFav').src = ICONO_LOTE.favicon;
    $('btnSubirIcono').disabled = false;
    aviso('Vista previa lista. Pulsa "Subir iconos".');
  } catch {
    aviso('No se pudo leer la imagen.', true);
  }
});

on('btnSubirIcono', 'click', async () => {
  try {
    const r = await api('/api/dev/icono', { method: 'POST', body: JSON.stringify(ICONO_LOTE) });
    refrescarPreviews(r.v);
    $('btnSubirIcono').disabled = true;
    $('c_icono').value = '';
    aviso('Iconos actualizados. Puede que necesites reinstalar la app.');
  } catch (err) {
    aviso(err.message, true);
  }
});

on('btnResetIcono', 'click', async () => {
  if (!confirm('¿Quitar los iconos personalizados y volver a los de fábrica?')) return;
  try {
    const r = await api('/api/dev/icono', { method: 'DELETE' });
    refrescarPreviews(r.v);
    aviso('Iconos restablecidos.');
  } catch (err) {
    aviso(err.message, true);
  }
});

function refrescarPreviews(v) {
  const q = v ? `?v=${v}` : `?v=${Date.now()}`;
  $('prev512').src = '/icon-512.png' + q;
  $('prev192').src = '/icon-192.png' + q;
  $('prev180').src = '/apple-touch-icon.png' + q;
  $('prevFav').src = '/favicon.png' + q;
}

// ---------- WhatsApp (OpenWA) ----------
const ESTADOS_WA = {
  ready: 'Conectado ✅',
  qr: 'Esperando escaneo del QR 📱',
  connecting: 'Conectando…',
  disconnected: 'Desconectado',
  created: 'Sesión creada, sin iniciar',
};

function pintarEstadoWa(info) {
  const el = $('waEstado');
  const qrBox = $('waQrBox');
  if (!info.configurado) {
    el.className = 'wa-estado muted';
    el.textContent = 'Guarda primero la URL, la API key y la sesión.';
    qrBox.hidden = true;
    return;
  }
  if (info.servidor === 'error') {
    el.className = 'wa-estado error';
    el.textContent = `No se pudo contactar con OpenWA: ${info.error || 'error'}`;
    qrBox.hidden = true;
    return;
  }
  if (!info.sesionExiste) {
    el.className = 'wa-estado muted';
    el.textContent = 'La sesión no existe todavía. Pulsa "Crear / iniciar sesión".';
    qrBox.hidden = true;
    return;
  }
  const conectado = !!info.conectado;
  el.className = 'wa-estado ' + (conectado ? 'ok' : 'muted');
  el.textContent = ESTADOS_WA[info.estado] || `Estado: ${info.estado || 'desconocido'}`;
  if (info.qr) {
    qrBox.hidden = false;
    qrBox.innerHTML = `<p class="muted">Escanea con WhatsApp → Dispositivos vinculados:</p><img alt="QR" src="${info.qr.startsWith('data:') ? info.qr : 'data:image/png;base64,' + info.qr}">`;
  } else {
    qrBox.hidden = true;
  }
}

async function comprobarWa(silencioso) {
  try {
    const info = await api('/api/dev/whatsapp');
    pintarEstadoWa(info);
    return info;
  } catch (err) {
    if (!silencioso) aviso(err.message, true);
  }
}

on('btnWaEstado', 'click', async () => { await comprobarWa(false); });

on('btnWaIniciar', 'click', async (e) => {
  e.target.disabled = true;
  try {
    await api('/api/dev/whatsapp/iniciar', { method: 'POST' });
    aviso('Sesión iniciada. Escanea el QR si aparece.');
    await comprobarWa(true);
  } catch (err) {
    aviso(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

on('btnWaProbar', 'click', async (e) => {
  const numero = $('c_waPrueba').value.trim();
  if (!numero) return aviso('Escribe un número para la prueba.', true);
  e.target.disabled = true;
  try {
    await api('/api/dev/whatsapp/probar', { method: 'POST', body: JSON.stringify({ numero }) });
    aviso('Mensaje de prueba enviado.');
  } catch (err) {
    aviso(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

// ---------- avanzado (JSON) ----------
on('btnReloadJson', 'click', recargar);

on('btnImportJson', 'click', async () => {
  try {
    const data = JSON.parse($('c_json').value);
    delete data.passwordHash;
    delete data.tienePassword;
    delete data.horas;
    const r = await api('/api/dev/config', { method: 'PUT', body: JSON.stringify(data) });
    CONFIG = r.config;
    aplicarApariencia(CONFIG);
    pintarFormulario(CONFIG);
    aviso('Configuración aplicada.');
  } catch (err) {
    aviso('JSON inválido: ' + err.message, true);
  }
});

// ---------- arranque ----------
async function abrir() {
  $('loginView').hidden = true;
  $('devView').hidden = false;
  try {
    await recargar();
  } catch (e) {
    aviso(e.message, true);
  }
}

(async function inicio() {
  try {
    const c = await (await fetch('/api/config')).json();
    aplicarApariencia(c);
  } catch {}
  if (TOKEN) {
    await abrir();
  }
})();
