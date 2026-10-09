/*
 * Service worker de BeautyOS.
 *
 * Deliberadamente mínimo: no guarda nada en caché. Una agenda que enseñara datos viejos
 * sin conexión haría que alguien agendara encima de una cita que ya no está libre, y eso
 * es peor que ver «sin conexión». Existe para dos cosas: que la app se pueda instalar en
 * el teléfono y que los avisos del sistema —«Sara pide mover una cita»— salgan aunque la
 * pestaña esté en segundo plano, y al tocarlos lleven a la pantalla correcta.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/agenda';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Si la app ya está abierta, se lleva allí en lugar de abrir otra ventana.
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
