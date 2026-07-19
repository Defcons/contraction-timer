// Service worker: web push notifications + minimal offline fallback.
const CACHE = 'bt-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './sync.js', './icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => clients.claim()));
});

// Network-first for same-origin GETs so deploys land normally; the cache is
// only an offline fallback (sync API calls are cross-origin and untouched).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((r) => r || (e.request.mode === 'navigate' ? caches.match('./') : Response.error())))
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
