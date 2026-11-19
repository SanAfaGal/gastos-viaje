import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { _resetFailures } from '../src/rates.mjs';
import { handle } from '../src/handlers.mjs';

// Las pruebas no dependen del entorno: Netlify define APP_PASSCODE y TURSO_* al construir.
delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const caller = (db) => (method, path, body, query = {}) => handle({ method, path, body, query: new URLSearchParams(query), db });

test('abonos: se guardan con su moneda y tasa, validan personas y viaje, se editan y se borran', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const call = caller(db);
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-10', 600]);
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  await call('POST', '/api/people', { id: 'leo', name: 'Leo' });
  await call('POST', '/api/people', { id: 'fuera', name: 'Fuera' });
  await call('POST', '/api/trips', { id: 'trip-1', name: 'Brasil', dest: 'BRL', home: 'COP', people_ids: ['ana', 'leo'] });
  const base = { date: '2026-11-10', amount_cents: 5000, from_person_id: 'leo', to_person_id: 'ana' };

  // En la moneda del destino (BRL): se guarda vacía y el monto en pesos sale al leer.
  assert.equal((await call('POST', '/api/payments', { ...base, id: 'p1', note: 'Pix' })).status, 201);
  assert.equal((await db.all('SELECT currency FROM payments WHERE id = ?', ['p1']))[0].currency, null);
  let p = (await call('GET', '/api/state')).body.payments.find((x) => x.id === 'p1');
  assert.deepEqual([p.currency, p.rate, p.amount_home, p.rate_estimated, p.trip_id], ['BRL', 600, 3000000, 0, 'trip-1']);

  // En la moneda de casa (COP): la tasa es 1.
  await call('POST', '/api/payments', { ...base, id: 'p2', currency: 'COP', amount_cents: 2000000 });
  p = (await call('GET', '/api/state')).body.payments.find((x) => x.id === 'p2');
  assert.deepEqual([p.currency, p.rate, p.amount_home], ['COP', 1, 2000000]);

  // Editar conserva el viaje y la hora de creación.
  const before = (await db.all('SELECT created_at FROM payments WHERE id = ?', ['p1']))[0].created_at;
  assert.equal((await call('PUT', '/api/payments/p1', { ...base, amount_cents: 7000 })).status, 200);
  const after = (await db.all('SELECT created_at, amount_cents FROM payments WHERE id = ?', ['p1']))[0];
  assert.deepEqual([after.created_at, after.amount_cents], [before, 7000]);

  // Validaciones.
  const bad = async (body) => (await call('POST', '/api/payments', { id: 'x', ...base, ...body })).status;
  assert.equal(await bad({ amount_cents: 0 }), 400);
  assert.equal(await bad({ amount_cents: 1.5 }), 400);
  assert.equal(await bad({ date: '2026-13-40' }), 400);
  assert.equal(await bad({ currency: 'ZZZ' }), 400);
  assert.equal(await bad({ to_person_id: 'leo' }), 400); // a sí mismo
  assert.equal(await bad({ to_person_id: '' }), 400);
  assert.equal(await bad({ to_person_id: 'fuera' }), 400); // no va en el viaje
  assert.equal(await bad({ to_person_id: 'nadie' }), 400);
  assert.equal(await bad({ trip_id: 'no-existe' }), 400);
  assert.equal((await db.all('SELECT * FROM payments WHERE id = ?', ['x'])).length, 0);

  // Con abonos no se borra a una persona, ni se la quita del viaje, ni se cambia la moneda; borrarlos lo libera.
  assert.equal((await call('DELETE', '/api/people/leo')).status, 409);
  assert.equal((await call('PUT', '/api/trips/trip-1', { name: 'Brasil', dest: 'USD', home: 'COP' })).status, 409);
  assert.equal((await call('PUT', '/api/trips/trip-1', { name: 'Brasil', dest: 'BRL', home: 'COP', people_ids: ['ana'] })).status, 409);
  assert.equal((await call('DELETE', '/api/payments/p1')).status, 200);
  assert.equal((await call('DELETE', '/api/payments/p2')).status, 200);
  assert.equal((await call('GET', '/api/state')).body.payments.length, 0);
  assert.equal((await call('DELETE', '/api/people/leo')).status, 200);
});

test('abonos: sin tasa al guardarse se completa solo al volver a pedir el estado, y borrar el viaje borra sus abonos', async () => {
  _resetFailures();
  const db = await openMemoryDb();
  const call = caller(db);
  await call('POST', '/api/people', { id: 'ana', name: 'Ana' });
  await call('POST', '/api/people', { id: 'leo', name: 'Leo' });
  await call('POST', '/api/trips', { id: 'trip-1', name: 'Brasil', dest: 'BRL', home: 'COP', people_ids: ['ana', 'leo'] });
  await call('POST', '/api/trips', { id: 'trip-2', name: 'Otro', dest: 'MXN', home: 'COP', people_ids: ['ana', 'leo'] });
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('sin red'); };
  try {
    await call('POST', '/api/payments', { id: 'p1', trip_id: 'trip-1', date: '2026-11-10', amount_cents: 5000, from_person_id: 'leo', to_person_id: 'ana' });
    assert.equal((await call('GET', '/api/state')).body.payments[0].amount_home ?? null, null); // sin red: sigue sin tasa
  } finally { globalThis.fetch = real; }
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', '2026-11-10', 600]);
  _resetFailures();
  const p = (await call('GET', '/api/state')).body.payments[0];
  assert.deepEqual([p.rate, p.amount_home], [600, 3000000]);

  assert.equal((await call('DELETE', '/api/trips/trip-1', undefined, { con_gastos: '1' })).status, 200);
  assert.equal((await db.all('SELECT * FROM payments')).length, 0);
});
