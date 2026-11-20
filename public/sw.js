// Service worker: guarda la app en el celular para que abra sin internet.
// Los datos (API) NO pasan por aquí: los maneja store.js con su copia local y su cola.
const CACHE = 'gastos-viaje-v120';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/css/screens.css', '/js/app.js', '/js/ui.js', '/js/accounts.mjs', '/js/shared.js', '/js/router.js', '/js/events.js', '/js/view-home.js', '/js/view-list.js', '/js/view-form.js', '/js/view-accounts.js', '/js/view-settings.js', '/js/view-spaces.js', '/js/spaces-card.mjs', '/js/view-map.js', '/js/place-picker.js', '/js/store.js', '/js/money.mjs', '/js/cards.mjs', '/js/places.mjs', '/js/order.mjs', '/js/filters.mjs', '/js/geolocate.mjs', '/js/stats.mjs', '/js/geosearch.mjs', '/js/nearby.mjs', '/js/picker.mjs', '/js/icons.mjs', '/js/select.mjs', '/js/datepicker.mjs',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/images/marker-icon.png', '/vendor/leaflet/images/marker-icon-2x.png', '/vendor/leaflet/images/marker-shadow.png', '/vendor/leaflet/images/layers.png', '/vendor/leaflet/images/layers-2x.png',
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

// La página, los módulos y los estilos se piden primero a internet: así una versión nueva se ve en la primera carga
// y no en la segunda. Lo guardado se usa solo si no hay red o si internet tarda más de NETWORK_WAIT_MS (para que
// la app abra igual con mala señal). Lo demás (imágenes, librerías) sale de lo guardado al instante y se actualiza
// en segundo plano.
const NETWORK_WAIT_MS = 3000;
const freshFirst = (url, req) => req.mode === 'navigate' || url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? '/index.html' : req;
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (!freshFirst(url, req)) return (await cache.match(key)) ?? (await network) ?? new Response('Sin conexión', { status: 503 });

      // Gana internet si responde a tiempo; si no, lo guardado, y la descarga sigue para dejarlo al día.
      const wait = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null));
      const fresh = await Promise.race([network, wait]);
      if (fresh) return fresh;
      return (await cache.match(key)) ?? (await network) ?? new Response('Sin conexión', { status: 503 });
    }),
  );
});
