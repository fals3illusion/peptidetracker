// Service worker: shows shot-day notifications and opens the app when one is tapped.
// No offline caching — the app always loads fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', ev => ev.waitUntil(self.clients.claim()));

self.addEventListener('push', ev => {
  let msg = {};
  try { msg = ev.data ? ev.data.json() : {}; } catch { msg = { body: ev.data?.text() }; }
  ev.waitUntil(self.registration.showNotification(msg.title || 'PeptideTracker', {
    body: msg.body || '',
    tag: msg.tag || 'pt',
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: msg.url || '/' },
  }));
});

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const url = new URL(ev.notification.data?.url || '/', self.location.origin).href;
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.location.origin));
    if (win) { await win.focus(); return win.navigate ? win.navigate(url).catch(() => {}) : undefined; }
    return self.clients.openWindow(url);
  })());
});
