// Service worker: web push notifications + minimal offline fallback.
const CACHE = 'bt-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Network-first for navigations so deploys land normally; cache is only an
// offline fallback.
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./', copy));
        return res;
      })
      .catch(() => caches.match('./'))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  // crit: 'low' = silent; 'high' = sticky + re-buzz on repeats (where supported)
  e.waitUntil(self.registration.showNotification(d.title || 'Baby Tracker', {
    body: d.body || '',
    tag: d.tag || 'bt',
    icon: './icon-192.png',
    badge: './icon-192.png',
    silent: d.crit === 'low',
    requireInteraction: d.crit === 'high',
    renotify: d.crit === 'high',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes('baby-tracker')) return c.focus();
    return clients.openWindow('./');
  }));
});
