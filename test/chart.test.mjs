import test from 'node:test';
import assert from 'node:assert/strict';
import { sparkline } from '../public/js/chart.mjs';

const pts = [580, 585, 590, 588, 592].map((rate, i) => ({ date: `2026-11-1${i}`, rate }));

test('gráfico: línea, marca del día elegido y resumen', () => {
  const g = sparkline(pts, '2026-11-12');
  assert.match(g.svg, /<path class="chart-line"/);
  assert.match(g.svg, /chart-dot/);
  assert.equal(g.min, 580);
  assert.equal(g.max, 592);
  assert.ok(Math.abs(g.change - 2.0690) < 0.001);
  assert.equal(g.selected.rate, 590);
});

test('gráfico: sin día elegido en el rango no marca nada; con pocos datos no dibuja', () => {
  assert.doesNotMatch(sparkline(pts, '2020-01-01').svg, /chart-dot/);
  assert.equal(sparkline([pts[0]], '2026-11-10'), null);
  assert.equal(sparkline(null, ''), null);
  const plano = sparkline([{ date: 'a', rate: 5 }, { date: 'b', rate: 5 }], 'a'); // tasa constante: sin dividir por cero
  assert.ok(!plano.svg.includes('NaN'));
});
