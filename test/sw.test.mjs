// Service worker: qué sirve cuando hay versión nueva. La app y sus archivos se piden primero a internet, para que
// una actualización se vea en la primera carga y no en la segunda. Lo guardado es para cuando no hay red o tarda.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://app.test';

// Carga sw.js con un `self`, un caché y un `fetch` falsos. `net(url)` devuelve el cuerpo de internet, o lanza
// si no hay red, o devuelve una promesa que nunca termina (red lenta). Los temporizadores no corren solos:
// la prueba dispara el de espera con `esperaAgotada()`.
function cargar({ saved = {}, net }) {
  const store = new Map(Object.entries(saved));
  const cache = {
    match: async (key) => {
      const k = typeof key === 'string' ? key : new URL(key.url).pathname;
      return store.has(k) ? new Response(store.get(k)) : undefined;
    },
    put: async (key, res) => store.set(typeof key === 'string' ? key : new URL(key.url).pathname, await res.text()),
  };
  const handlers = {};
  const timers = [];
  const ctx = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    location: { origin: ORIGIN },
    fetch: async (req) => {
      const body = await net(new URL(typeof req === 'string' ? req : req.url).pathname);
      return new Response(body, { status: 200 });
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    Response, URL, Promise,
  };
  vm.runInNewContext(source, ctx);
  return {
    store,
    // El service worker registra su temporizador de espera un instante después de recibir la petición.
    esperaAgotada: async () => {
      for (let i = 0; i < 50 && !timers.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
      timers.forEach((fn) => fn());
    },
    // Devuelve el cuerpo servido, o null si el service worker no intervino (no llamó a respondWith).
    // No es async a propósito: devuelve la promesa de la respuesta sin esperarla, para poder agotar la espera mientras tanto.
    pedir: (pathname, { navigate = false, method = 'GET' } = {}) => {
      let respuesta = null;
      const request = { method, url: ORIGIN + pathname, mode: navigate ? 'navigate' : 'cors' };
      handlers.fetch({ request, respondWith: (p) => { respuesta = p; } });
      return respuesta;
    },
  };
}
const leer = async (promesa) => (promesa ? (await promesa).text() : null);

test('con internet, la página y los módulos salen de internet aunque haya una versión vieja guardada', async () => {
  const sw = cargar({ saved: { '/index.html': 'vieja', '/js/app.js': 'js viejo' }, net: async (p) => (p === '/js/app.js' ? 'js nuevo' : 'nueva') });
  assert.equal(await leer(await sw.pedir('/', { navigate: true })), 'nueva');
  assert.equal(await leer(await sw.pedir('/js/app.js')), 'js nuevo');
  assert.equal(await leer(await sw.pedir('/css/app.css')), 'nueva');
});

test('lo que llega de internet queda guardado para cuando no haya red', async () => {
  const sw = cargar({ saved: { '/index.html': 'vieja' }, net: async () => 'nueva' });
  await leer(await sw.pedir('/', { navigate: true }));
  assert.equal(sw.store.get('/index.html'), 'nueva');
});

test('sin red, se sirve lo guardado', async () => {
  const sw = cargar({ saved: { '/index.html': 'guardada', '/js/app.js': 'js guardado' }, net: async () => { throw new TypeError('sin red'); } });
  assert.equal(await leer(await sw.pedir('/', { navigate: true })), 'guardada');
  assert.equal(await leer(await sw.pedir('/js/app.js')), 'js guardado');
});

test('con la red muy lenta, se sirve lo guardado en vez de dejar la pantalla en blanco', async () => {
  const sw = cargar({ saved: { '/index.html': 'guardada' }, net: () => new Promise(() => {}) });
  const respuesta = leer(sw.pedir('/', { navigate: true }));
  await sw.esperaAgotada();
  assert.equal(await respuesta, 'guardada');
});

test('sin red y sin nada guardado responde 503', async () => {
  const sw = cargar({ net: async () => { throw new TypeError('sin red'); } });
  const res = await (await sw.pedir('/js/app.js'));
  assert.equal(res.status, 503);
});

test('imágenes y librerías siguen saliendo de lo guardado al instante', async () => {
  let pedidos = 0;
  const sw = cargar({ saved: { '/icon.svg': 'icono guardado' }, net: async () => { pedidos += 1; return 'icono nuevo'; } });
  assert.equal(await leer(await sw.pedir('/icon.svg')), 'icono guardado');
  assert.equal(pedidos, 1); // se actualiza en segundo plano
});

test('la API y otros orígenes no pasan por el service worker', async () => {
  const sw = cargar({ net: async () => 'x' });
  assert.equal(await sw.pedir('/api/state'), null);
  assert.equal(await sw.pedir('/js/app.js', { method: 'POST' }), null);
});
