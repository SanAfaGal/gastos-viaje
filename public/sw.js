// Service worker: guarda la app en el celular para que abra sin internet.
// Los datos (API) NO pasan por aquí: los maneja store.js con su copia local y su cola.
const CACHE = 'gastos-viaje-v9';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/js/app.js', '/js/store.js', '/js/money.mjs', '/js/cards.mjs',
  '/js/settlement.mjs', '/js/currencies.mjs', '/js/chart.mjs', '/js/theme.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Archivos de la app: sirve lo guardado al instante y lo actualiza en segundo plano.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? '/index.html' : req;
      const cached = await cache.match(key);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      return cached ?? (await network) ?? new Response('Sin conexión', { status: 503 });
    }),
  );
});
