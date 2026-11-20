// Arranque del acceso (store.js): cuándo se pide el código y cuándo se sabe que el servidor está abierto.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const responder = (status) => async () => ({ ok: status < 400, status, json: async () => (status < 400 ? { ok: true } : { error: 'Código incorrecto' }) });

// Cada caso importa una instancia nueva del módulo, con el almacenamiento como lo deja `antes`.
async function arrancar(caso, antes = () => {}) {
  mem.clear();
  antes();
  return import(`../public/js/store.js?caso=${caso}`);
}

test('sin código guardado y servidor desconocido: pide el código desde el primer instante', async () => {
  const store = await arrancar(1);
  assert.equal(store.net.needsLogin, true);
});

test('con código guardado: no pide el código al arrancar', async () => {
  const store = await arrancar(2, () => mem.set('bg_pass', 'x'));
  assert.equal(store.net.needsLogin, false);
});

test('servidor ya marcado como abierto: no pide el código', async () => {
  const store = await arrancar(3, () => mem.set('bg_open', '1'));
  assert.equal(store.net.needsLogin, false);
});

test('una respuesta 200 sin código marca el servidor como abierto', async () => {
  const store = await arrancar(4);
  assert.equal(store.net.needsLogin, true);
  globalThis.fetch = responder(200);
  await store.ping();
  assert.equal(store.net.needsLogin, false);
  assert.equal(localStorage.getItem('bg_open'), '1');
});

test('una respuesta 200 con código guardado no marca el servidor como abierto', async () => {
  const store = await arrancar(5, () => mem.set('bg_pass', 'x'));
  globalThis.fetch = responder(200);
  await store.ping();
  assert.equal(localStorage.getItem('bg_open'), null);
});

test('un 401 vuelve a pedir el código y borra la marca', async () => {
  const store = await arrancar(6, () => mem.set('bg_open', '1'));
  assert.equal(store.net.needsLogin, false);
  globalThis.fetch = responder(401);
  await assert.rejects(store.ping(), { status: 401 });
  assert.equal(store.net.needsLogin, true);
  assert.equal(localStorage.getItem('bg_open'), null);
});

test('setPass("") (cerrar sesión) borra la marca de abierto', async () => {
  const store = await arrancar(7, () => mem.set('bg_open', '1'));
  store.setPass('');
  assert.equal(localStorage.getItem('bg_open'), null);
});

test('un 500 en la primera visita no marca el servidor como abierto', async () => {
  const store = await arrancar(8);
  globalThis.fetch = responder(500);
  await assert.rejects(store.ping(), { status: 500 });
  assert.equal(store.net.needsLogin, true);
  assert.equal(localStorage.getItem('bg_open'), null);
});

test('un 429 sin código tampoco marca el servidor como abierto', async () => {
  const store = await arrancar(9);
  globalThis.fetch = responder(429);
  await assert.rejects(store.ping(), { status: 429 });
  assert.equal(store.net.needsLogin, true);
  assert.equal(localStorage.getItem('bg_open'), null);
});
