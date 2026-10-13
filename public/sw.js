// Service worker mínimo para que el panel se pueda instalar como app.
// No cachea datos (las citas siempre vienen frescas del servidor).

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Un manejador de fetch es requisito para la instalación de la PWA.
self.addEventListener('fetch', () => {});

// Al tocar una notificación, abre o enfoca el panel.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if (c.url.includes('/panel') && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/panel');
    })
  );
});
