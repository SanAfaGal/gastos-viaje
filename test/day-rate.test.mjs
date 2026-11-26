import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRate } from '../public/js/money.mjs';

const ex = (o = {}) => ({ currency: null, rate: 110.08, rate_date: '2026-11-17', rate_estimated: 0, ...o });

test('toma la tasa de los gastos en la moneda del destino', () => {
  assert.deepEqual(dayRate([ex()], 'BRL'), { rate: 110.08, estimated: false });
  assert.deepEqual(dayRate([ex({ currency: 'BRL' })], 'BRL'), { rate: 110.08, estimated: false });
});

test('ignora gastos en otra moneda y los que aún no tienen tasa', () => {
  assert.equal(dayRate([ex({ currency: 'COP', rate: 1 }), ex({ currency: 'USD', rate: 4000 })], 'BRL'), null);
  assert.equal(dayRate([ex({ rate: null })], 'BRL'), null);
  assert.equal(dayRate([], 'BRL'), null);
});

test('prefiere la tasa definitiva a la estimada', () => {
  const items = [ex({ rate: 109, rate_estimated: 1 }), ex({ rate: 110.08 })];
  assert.deepEqual(dayRate(items, 'BRL'), { rate: 110.08, estimated: false });
});

test('si solo hay estimadas, la devuelve marcada como estimada', () => {
  assert.deepEqual(dayRate([ex({ rate: 109, rate_estimated: 1 })], 'BRL'), { rate: 109, estimated: true });
});

test('con varias tasas definitivas usa la de fecha más reciente', () => {
  const items = [ex({ rate: 108, rate_date: '2026-11-15' }), ex({ rate: 110, rate_date: '2026-11-17' }), ex({ rate: 109, rate_date: '2026-11-16' })];
  assert.equal(dayRate(items, 'BRL').rate, 110);
});
