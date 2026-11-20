// Un código guardado que el servidor ya no acepta (se cambió APP_PASSCODE, se regeneró o se desactivó el espacio)
// no debe gastar los intentos de la red: cada intento con código cuenta (10 cada 15 minutos) y recargar la
// página lanza varias peticiones a la vez. Con el código muerto, una recarga o dos dejaban a la persona
// bloqueada con "Demasiados intentos" sin haber escrito nada.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.APP_PASSCODE;
delete process.env.ADMIN_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// Cada caso importa una instancia nueva del módulo. `respuestas` es la lista de estados que devuelve el servidor,
// en orden (el último se repite); `pedidos` guarda el código que llevaba cada petición.
async function arrancar(caso, { guardado = 'viejo', respuestas = [401] } = {}) {
  mem.clear();
  if (guardado) mem.set('bg_pass', guardado);
  const pedidos = [];
  globalThis.fetch = async (url, opts = {}) => {
    pedidos.push(opts.headers?.['x-passcode']);
    const status = respuestas[Math.min(pedidos.length - 1, respuestas.length - 1)];
    if (status === 'sin-red') throw new TypeError('sin red');
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => (status < 400 ? { ok: true } : { error: 'x' }) };
  };
  const store = await import(`../public/js/store.js?muerto=${caso}`);
  return { store, pedidos };
}

test('un 401 con código guardado olvida ese código', async () => {
  const { store } = await arrancar(1);
  await assert.rejects(store.ping(), { status: 401 });
  assert.equal(localStorage.getItem('bg_pass') ?? '', '');
  assert.equal(store.net.needsLogin, true);
});

test('con un código sin comprobar, las peticiones simultáneas esperan a la primera y solo sale una', async () => {
  const { store, pedidos } = await arrancar(2, { respuestas: [401] });
  const todas = await Promise.allSettled(Array.from({ length: 6 }, () => store.ping()));
  assert.equal(pedidos.length, 1, 'solo la primera petición llega al servidor');
  assert.deepEqual(todas.map((r) => r.status), Array(6).fill('rejected'));
  assert.ok(todas.every((r) => r.reason.status === 401));
});

test('si la primera responde bien, las demás salen y después ya nada espera', async () => {
  const { store, pedidos } = await arrancar(3, { respuestas: [200] });
  await Promise.all(Array.from({ length: 5 }, () => store.ping()));
  assert.equal(pedidos.length, 5);
  assert.ok(pedidos.every((c) => c === 'viejo'));
  await store.ping(); // ya comprobado: sale sin esperar a nadie
  assert.equal(pedidos.length, 6);
});

test('recargar después de un 401 no manda ningún código y pide el acceso desde el inicio', async () => {
  const primera = await arrancar(4);
  await assert.rejects(primera.store.ping(), { status: 401 });
  // "Recarga": nueva instancia del módulo con el mismo almacenamiento del navegador.
  const pedidos = [];
  globalThis.fetch = async (url, opts = {}) => {
    pedidos.push(opts.headers?.['x-passcode']);
    return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'x' }) };
  };
  const store = await import('../public/js/store.js?muerto=4-recarga');
  assert.equal(store.net.needsLogin, true);
  await store.syncNow().catch(() => {});
  assert.ok(pedidos.every((c) => !c), 'las peticiones de la recarga van sin código, y sin código no se cuentan intentos');
});

test('sin red la primera, las demás igual se intentan y nada se queda esperando', async () => {
  const { store, pedidos } = await arrancar(5, { respuestas: ['sin-red', 200] });
  const todas = await Promise.allSettled(Array.from({ length: 3 }, () => store.ping()));
  assert.equal(todas[0].status, 'rejected');
  assert.equal(todas[0].reason.offline, true);
  assert.equal(pedidos.length, 3);
  assert.deepEqual(todas.slice(1).map((r) => r.status), ['fulfilled', 'fulfilled']);
});

test('un 403 (espacio desactivado) olvida el código, guarda el motivo y las demás peticiones no salen', async () => {
  const { store, pedidos } = await arrancar(8, { respuestas: [403] });
  const todas = await Promise.allSettled(Array.from({ length: 4 }, () => store.ping()));
  assert.equal(pedidos.length, 1);
  assert.ok(todas.every((r) => r.status === 'rejected'));
  assert.equal(todas[0].reason.status, 403);
  assert.equal(localStorage.getItem('bg_pass') ?? '', '');
  assert.equal(store.net.needsLogin, true);
  assert.equal(store.net.lockReason, 'x'); // el texto que mandó el servidor (aquí el de la prueba)
});

test('el motivo se borra al poner un código nuevo y no aparece con un 401', async () => {
  const { store } = await arrancar(9, { respuestas: [403, 401] });
  await assert.rejects(store.ping(), { status: 403 });
  assert.equal(store.net.lockReason, 'x');
  store.setPass('otro');
  assert.equal(store.net.lockReason, '');
  await assert.rejects(store.ping(), { status: 401 });
  assert.equal(store.net.lockReason, '');
});

test('la pantalla de acceso muestra el motivo, escapado', async () => {
  const fs = await import('node:fs');
  const router = fs.readFileSync(new URL('../public/js/router.js', import.meta.url), 'utf8');
  assert.match(router, /store\.net\.lockReason \? `<p class="form-error" role="alert">\$\{esc\(store\.net\.lockReason\)\}<\/p>`/);
});

test('un 429 no olvida el código: no es que el código esté mal, es que hay que esperar', async () => {
  const { store } = await arrancar(6, { respuestas: [429] });
  await assert.rejects(store.ping(), { status: 429 });
  assert.equal(localStorage.getItem('bg_pass'), 'viejo');
});

test('un 404 o un 400 sí confirman que el código vale: lo siguiente no espera', async () => {
  const { store, pedidos } = await arrancar(7, { respuestas: [404, 200] });
  await assert.rejects(store.ping(), { status: 404 });
  await store.ping();
  assert.equal(pedidos.length, 2);
  assert.equal(localStorage.getItem('bg_pass'), 'viejo');
});
