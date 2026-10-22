/* DIOPTRA — service worker : l'application s'ouvre même sans internet */
const VERSION = '__VERSION__';
const CACHE = 'dioptra-' + VERSION;
const COQUILLE = __FICHIERS__;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('dioptra-') && k !== CACHE && k !== 'dioptra-polices').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;          // API : toujours le réseau
  // Polices Google : gardées en cache après le premier chargement
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open('dioptra-polices').then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; } catch (_) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // Pages : réseau d'abord (nouvelle version), sinon la copie locale
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('/index.html', c)); return r; })
      .catch(() => caches.match('/index.html')));
    return;
  }
  // Fichiers de l'application : copie locale d'abord
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  })));
});
