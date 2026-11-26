import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement, splitEqual } from '../public/js/settlement.mjs';
import { parseAmount, toHome, fmtDest, fmtHome, setCurrencies } from '../public/js/money.mjs';

test('splitEqual reparte el sobrante de a un peso', () => {
  const parts = splitEqual(100, ['a', 'b', 'c']);
  assert.deepEqual(parts, { a: 34, b: 33, c: 33 });
  assert.equal(Object.values(parts).reduce((x, y) => x + y, 0), 100);
});

test('tarjeta prestada pagando gasto compartido entre dos', () => {
  // María pagó 90.000 con su tarjeta; es de yo y Juan en partes iguales.
  const r = computeSettlement(
    [{ amount_home: 90000, payer_id: 'maria', beneficiary_ids: ['yo', 'juan'] }],
    ['yo', 'juan', 'maria'],
  );
  const net = Object.fromEntries(r.balances.map((b) => [b.person_id, b.net]));
  assert.deepEqual(net, { yo: -45000, juan: -45000, maria: 90000 });
  assert.deepEqual(
    r.transfers.map((t) => `${t.from}->${t.to}:${t.amount}`).sort(),
    ['juan->maria:45000', 'yo->maria:45000'],
  );
});

test('los saldos siempre suman cero y los pagos los dejan en cero', () => {
  const expenses = [
    { amount_home: 100001, payer_id: 'a', beneficiary_ids: ['a', 'b', 'c'] },
    { amount_home: 55555, payer_id: 'b', beneficiary_ids: ['c'] },
    { amount_home: 20000, payer_id: 'c', beneficiary_ids: ['a', 'b'] },
  ];
  const r = computeSettlement(expenses, ['a', 'b', 'c']);
  assert.equal(r.balances.reduce((s, b) => s + b.net, 0), 0);
  const left = Object.fromEntries(r.balances.map((b) => [b.person_id, b.net]));
  for (const t of r.transfers) {
    left[t.from] += t.amount;
    left[t.to] -= t.amount;
  }
  assert.ok(Object.values(left).every((v) => v === 0));
});

test('gastos sin tasa se cuentan como pendientes y no entran', () => {
  const r = computeSettlement(
    [{ amount_home: null, payer_id: 'a', beneficiary_ids: ['b'] }],
    ['a', 'b'],
  );
  assert.equal(r.pending, 1);
  assert.deepEqual(r.transfers, []);
});

test('parseBrl entiende coma, punto y miles', () => {
  assert.equal(parseAmount('12,50'), 1250);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('1.234,56'), 123456);
  assert.equal(parseAmount('R$ 8'), 800);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('abc'), null);
});

test('toHome convierte a tu moneda y respeta sus decimales', () => {
  assert.equal(toHome(1000, 585.5, 0), 585500); // R$ 10 a COP sin centavos: $ 5.855
  assert.equal(toHome(1000, 0.2, 2), 200); // a una moneda con centavos
  assert.equal(toHome(333, 585.5, 0) % 100, 0);
});

test('monedas configurables: formato y repartos con unidad', () => {
  setCurrencies('USD', 'EUR');
  assert.match(fmtDest(1050), /10[.,]50/);
  assert.match(fmtHome(1050), /10,50/);
  setCurrencies('BRL', 'COP');
  // COP: unidad de 100 centésimas = 1 peso; 1000 pesos entre 3 en pesos enteros
  const r = computeSettlement(
    [{ amount_home: 100000, payer_id: 'a', beneficiary_ids: ['a', 'b', 'c'] }],
    ['a', 'b', 'c'],
    100,
  );
  assert.ok(r.balances.every((b) => b.paid % 100 === 0 && b.consumed % 100 === 0));
  assert.equal(r.balances.reduce((s, b) => s + b.net, 0), 0);
});

test('gasto sin monto: no entra en las cuentas y no se confunde con "sin tasa"', () => {
  const r = computeSettlement([
    { amount_home: 1000, payer_id: 'a', beneficiary_ids: ['a', 'b'] },
    { amount_home: null, amount_pending: 1, payer_id: 'a', beneficiary_ids: ['a', 'b'] },
    { amount_home: null, payer_id: 'b', beneficiary_ids: ['a', 'b'] },
  ], ['a', 'b']);
  assert.equal(r.noAmount, 1);
  assert.equal(r.pending, 1);
});
