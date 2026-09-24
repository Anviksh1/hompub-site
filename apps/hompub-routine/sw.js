/* HomPub Routine service worker: offline app shell + notification clicks. */
const CACHE = 'hompub-routine-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  '../../icon-192.png',
  '../../icon-512.png',
  '../../favicon.ico',
  '../../favicon-32.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('hompub-routine-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up right away), cache as the offline fallback.
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !isFont) return;
  ev.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const data = ev.notification.data || {};
  ev.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find(c => new URL(c.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (ev.action === 'done' && data.id) {
      if (client) client.postMessage({ type: 'done', id: data.id, date: data.date });
      return;
    }
    if (client) return client.focus();
    return self.clients.openWindow('./');
  })());
});
