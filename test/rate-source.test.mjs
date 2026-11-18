// Trazabilidad de las tasas: cada tasa guardada dice de qué fuente salió.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileDb, openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { _resetFailures } from '../src/rates.mjs';
import { addDays, todayStr } from '../public/js/money.mjs';

delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const today = todayStr();
const day = addDays(today, -3);

// Fuente simulada. `principal` = { fecha: tasa } de fawazahmed0 (null = caída); `frankfurter` = { fecha: tasa } de respaldo.
async function conFuentes({ principal, frankfurter = {} }, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('frankfurter')) {
      const fecha = u.match(/date=([\d-]+)/)?.[1] ?? today;
      return frankfurter[fecha] == null
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ date: fecha, rate: frankfurter[fecha] }) };
    }
    if (!principal) return { ok: false, status: 500, json: async () => ({}) };
    const version = u.match(/currency-api@([^/]+)\/v1/)?.[1] ?? u.match(/\/\/([^.]+)\.currency-api/)?.[1];
    const fecha = version === 'latest' ? today : version;
    return principal[fecha] == null
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ date: fecha, brl: { cop: principal[fecha] } }) };
  };
  _resetFailures();
  try { return await fn(); } finally { globalThis.fetch = real; }
}

async function baseDeDatos(db) {
  const call = (method, path, body, query = {}) => handle({ method, path, body, query: new URLSearchParams(query), db });
  await call('POST', '/api/people', { id: 'yo', name: 'Yo' });
  await call('POST', '/api/payment-methods', { id: 'efe', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
  return call;
}
// Leer el estado también consulta la fuente (corrige tasas de días cerrados): siempre con fuentes simuladas.
const estado = (call, fuentes = { principal: null }) => conFuentes(fuentes, () => call('GET', '/api/state')).then((r) => r.body);
const gasto = (id, date) => ({ id, date, amount_cents: 10000, description: '', payment_method_id: 'efe', beneficiary_ids: ['yo'] });

test('el gasto guarda la fuente de su tasa y la API la devuelve', async () => {
  const db = await openMemoryDb();
  const call = await baseDeDatos(db);
  await conFuentes({ principal: { [day]: 580 } }, () => call('POST', '/api/expenses', gasto('g1', day)));
  const e = (await estado(call, { principal: { [day]: 580 } })).expenses.find((x) => x.id === 'g1');
  assert.equal(e.rate, 580);
  assert.equal(e.rate_source, 'fawazahmed0');
  const guardada = (await db.all('SELECT source, fetched_at FROM rates WHERE date = ?', [day]))[0];
  assert.equal(guardada.source, 'fawazahmed0');
  assert.ok(guardada.fetched_at);
});

test('si la fuente principal falla, el gasto dice que la tasa es de Frankfurter', async () => {
  const db = await openMemoryDb();
  const call = await baseDeDatos(db);
  await conFuentes({ principal: null, frankfurter: { [day]: 587.01 } }, () => call('POST', '/api/expenses', gasto('g2', day)));
  const e = (await estado(call, { principal: null, frankfurter: { [day]: 587.01 } })).expenses.find((x) => x.id === 'g2');
  assert.equal(e.rate, 587.01);
  assert.equal(e.rate_source, 'frankfurter');
});

test('GET /api/rate también dice de qué fuente sale el valor', async () => {
  const db = await openMemoryDb();
  const call = await baseDeDatos(db);
  const r = await conFuentes({ principal: { [day]: 580 } }, () => call('GET', '/api/rate', null, { date: day }));
  assert.equal(r.body.source, 'fawazahmed0');
  assert.equal(r.body.rate_date, day);
});

test('un gasto sin tasa (sin internet) no tiene fuente; al conseguirla se anota', async () => {
  const db = await openMemoryDb();
  const call = await baseDeDatos(db);
  await conFuentes({ principal: null }, () => call('POST', '/api/expenses', gasto('g3', day)));
  let e = (await estado(call)).expenses.find((x) => x.id === 'g3');
  assert.equal(e.rate, null);
  assert.equal(e.rate_source, null);
  e = (await estado(call, { principal: { [day]: 581 } })).expenses.find((x) => x.id === 'g3');
  assert.equal(e.rate_source, 'fawazahmed0');
});

test('migración: una base sin columnas de fuente las recibe y conserva sus datos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gastos-fuente-'));
  const file = join(dir, 'viejo.db');
  try {
    let db = await openFileDb(file);
    const call = await baseDeDatos(db);
    await conFuentes({ principal: { [day]: 580 } }, () => call('POST', '/api/expenses', gasto('g4', day)));
    // Se deja la base como estaba antes de registrar la fuente.
    await db.run('ALTER TABLE rates DROP COLUMN source');
    await db.run('ALTER TABLE rates DROP COLUMN fetched_at');
    await db.run('ALTER TABLE expenses DROP COLUMN rate_source');

    db = await openFileDb(file); // al abrir se agregan las columnas
    const cols = async (t) => (await db.all(`PRAGMA table_info(${t})`)).map((c) => c.name);
    assert.ok((await cols('rates')).includes('source') && (await cols('rates')).includes('fetched_at'));
    assert.ok((await cols('expenses')).includes('rate_source'));
    const e = (await estado((m, p) => handle({ method: m, path: p, db }))).expenses.find((x) => x.id === 'g4');
    assert.equal(e.rate, 580); // la tasa que ya tenía sigue ahí
    assert.equal(e.rate_source, null); // y se sabe que no se registró su fuente
    const rows = await db.all('SELECT rate, source FROM rates WHERE date = ?', [day]);
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ rate: 580, source: null }]);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* en Windows el archivo sigue abierto: se limpia solo al borrar la carpeta temporal */ }
  }
});

test('respaldo: la fuente de la tasa viaja en el archivo y se restaura', async () => {
  const origen = await openMemoryDb();
  const call = await baseDeDatos(origen);
  await conFuentes({ principal: { [day]: 580 } }, () => call('POST', '/api/expenses', gasto('g5', day)));
  const copia = (await call('GET', '/api/backup')).body;
  assert.equal(copia.expenses.find((x) => x.id === 'g5').rate_source, 'fawazahmed0');

  const destino = await openMemoryDb();
  const r = await handle({ method: 'POST', path: '/api/restore', body: copia, db: destino });
  assert.equal(r.status, 200);
  const e = (await estado((m, p) => handle({ method: m, path: p, db: destino }), { principal: { [day]: 580 } })).expenses.find((x) => x.id === 'g5');
  assert.equal(e.rate, 580);
  assert.equal(e.rate_source, 'fawazahmed0');

  // Un archivo con una fuente absurda se rechaza.
  const mala = structuredClone(copia);
  mala.expenses[0].rate_source = 'x'.repeat(100);
  const otra = await openMemoryDb();
  assert.equal((await handle({ method: 'POST', path: '/api/restore', body: mala, db: otra })).status, 400);
});

test('"Actualizar tasas": anota la fuente aunque el valor no cambie', async () => {
  const db = await openMemoryDb();
  const call = await baseDeDatos(db);
  await conFuentes({ principal: { [day]: 580 } }, () => call('POST', '/api/expenses', gasto('g6', day)));
  await db.run('UPDATE expenses SET rate_source = NULL WHERE id = ?', ['g6']); // como un gasto guardado antes de registrar la fuente
  const r = await conFuentes({ principal: { [day]: 580 } }, () => call('POST', '/api/rates/refresh', null));
  assert.equal(r.body.changed, 0); // el valor es el mismo: no cuenta como cambio
  const e = (await estado(call, { principal: { [day]: 580 } })).expenses.find((x) => x.id === 'g6');
  assert.equal(e.rate_source, 'fawazahmed0');
});
