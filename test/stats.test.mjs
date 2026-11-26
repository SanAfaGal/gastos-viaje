import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, byDay, summary } from '../public/js/stats.mjs';

const ex = (id, date, home, dest = 1000) => ({ id, date, amount_home: home, amount_cents: dest });

test('gasto por día: rellena con ceros los días sin gastos y suma por día', () => {
  const list = [ex('a', '2026-11-10', 100), ex('b', '2026-11-10', 50), ex('c', '2026-11-13', 200)];
  const d = byDay(list, { today: '2026-11-13' });
  assert.deepEqual(d.map((x) => [x.date, x.home, x.count]), [
    ['2026-11-10', 150, 2], ['2026-11-11', 0, 0], ['2026-11-12', 0, 0], ['2026-11-13', 200, 1],
  ]);
  assert.equal(d[0].dest, 2000);
});

test('gasto por día: llega hasta hoy y se limita a los últimos N días', () => {
  const list = [ex('a', '2026-10-01', 100), ex('b', '2026-11-10', 200)];
  const d = byDay(list, { today: '2026-11-13', days: 5 });
  assert.deepEqual(d.map((x) => x.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.deepEqual(byDay([], { today: '2026-11-13' }), []);
});

test('gasto por día: un gasto sin tasa no suma en pesos pero sí en la moneda del destino', () => {
  const d = byDay([ex('a', '2026-11-10', null, 700)], { today: '2026-11-10' });
  assert.deepEqual([d[0].home, d[0].dest], [0, 700]);
});

test('reparto: ordena de mayor a menor, saca porcentajes y junta el resto en Otros', () => {
  const list = [ex('1', 'x', 500), ex('2', 'x', 300), ex('3', 'x', 100), ex('4', 'x', 60), ex('5', 'x', 30), ex('6', 'x', 10)];
  const rows = breakdown(list, (e) => ({ id: e.id, label: `m${e.id}` }), { max: 4 });
  assert.deepEqual(rows.map((r) => [r.id, r.home]), [['1', 500], ['2', 300], ['3', 100], ['__otros', 100]]);
  assert.equal(rows[3].count, 3);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.pct, 0) - 100) < 1e-9);
  assert.equal(rows[0].pct, 50);
});

test('reparto: ignora los gastos sin clave y no falla con total cero', () => {
  const list = [ex('1', 'x', 100), ex('2', 'x', 100)];
  assert.deepEqual(breakdown(list, (e) => (e.id === '1' ? { id: 'a', label: 'A' } : null)).map((r) => r.id), ['a']);
  const zero = breakdown([ex('1', 'x', null)], () => ({ id: 'a', label: 'A' }));
  assert.equal(zero[0].pct, 0);
  assert.deepEqual(breakdown([], () => null), []);
});

test('resumen: promedio por día corrido (cuentan los días sin gastos), hoy y el gasto mayor', () => {
  const list = [ex('a', '2026-11-10', 300), ex('b', '2026-11-12', 900), ex('c', '2026-11-12', 300), ex('d', '2026-11-12', null)];
  const s = summary(list, '2026-11-12');
  assert.equal(s.span, 3);
  assert.equal(s.total, 1500);
  assert.equal(s.perDay, 500);
  assert.equal(s.today, 1200);
  assert.equal(s.top.id, 'b');
  assert.equal(s.unconverted, 1);
  // Si hoy es posterior al último gasto, el día de hoy también cuenta para el promedio.
  assert.equal(summary(list, '2026-11-14').span, 5);
  assert.equal(summary([], '2026-11-14'), null);
});

test('gasto sin monto: no suma, no es "sin convertir" y se cuenta aparte', () => {
  const list = [
    { id: 'a', date: '2026-11-10', amount_cents: 1000, amount_home: 5000 },
    { id: 'p', date: '2026-11-10', amount_cents: 0, amount_home: null, amount_pending: 1 },
    { id: 'r', date: '2026-11-10', amount_cents: 700, amount_home: null },
  ];
  const s = summary(list, '2026-11-10');
  assert.equal(s.total, 5000);
  assert.equal(s.unconverted, 1);
  assert.equal(s.noAmount, 1);
});
