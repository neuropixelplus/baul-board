// Service worker de NP+ RefBoards: solo recibe los avisos push y abre el shot al tocarlos (no guarda nada en caché).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'NP+ RefBoards', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NP+ RefBoards', {
    body: d.body, tag: d.tag, data: { url: d.url || self.registration.scope },
    icon: 'icon-192.png', badge: 'icon-192.png' }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all.find(x => x.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ open: url }); return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
