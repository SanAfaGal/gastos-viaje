import test from 'node:test';
import assert from 'node:assert/strict';
import { changeAt, nearestIndex, sparkline } from '../public/js/chart.mjs';

const pts = [580, 585, 590, 588, 592].map((rate, i) => ({ date: `2026-11-1${i}`, rate }));

test('gráfico: línea, posiciones por punto y resumen', () => {
  const g = sparkline(pts, '2026-11-12');
  assert.match(g.svg, /<path class="chart-line"/);
  assert.doesNotMatch(g.svg, /<circle/); // los puntos van como HTML para que no se deformen
  assert.equal(g.xs.length, 5);
  assert.equal(g.ys.length, 5);
  assert.ok(g.xs.every((x, i) => i === 0 || x > g.xs[i - 1])); // de izquierda a derecha
  assert.ok(g.ys[4] < g.ys[0]); // 592 queda más arriba (y menor) que 580
  assert.equal(g.min, 580);
  assert.equal(g.max, 592);
  assert.equal(g.selectedIndex, 2);
  assert.equal(g.selected.rate, 590);
  assert.ok(Math.abs(g.change - 2.069) < 0.001);
});

test('gráfico: día fuera del rango, pocos datos y tasa constante', () => {
  assert.equal(sparkline(pts, '2020-01-01').selectedIndex, -1);
  assert.equal(sparkline([pts[0]], '2026-11-10'), null);
  assert.equal(sparkline(null, ''), null);
  const plano = sparkline([{ date: 'a', rate: 5 }, { date: 'b', rate: 5 }], 'a');
  assert.ok(!plano.svg.includes('NaN') && plano.ys.every(Number.isFinite));
});

test('recorrer: el índice más cercano a la posición del dedo, con límites', () => {
  assert.equal(nearestIndex(5, 0), 0);
  assert.equal(nearestIndex(5, 1), 4);
  assert.equal(nearestIndex(5, 0.5), 2);
  assert.equal(nearestIndex(5, -3), 0);
  assert.equal(nearestIndex(5, 9), 4);
  assert.equal(nearestIndex(90, 0.5), 45);
  const g = sparkline(pts, '');
  // la posición horizontal de cada punto vuelve a dar su propio índice
  g.xs.forEach((x, i) => assert.equal(nearestIndex(5, x / 100), i));
});

test('variación respecto al primer día del período', () => {
  assert.equal(changeAt(pts, 0), 0);
  assert.ok(Math.abs(changeAt(pts, 4) - 2.069) < 0.001);
});
