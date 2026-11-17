import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCoords, hasLocation, placesFrom } from '../public/js/places.mjs';

test('hasLocation: solo con lat y lng válidas', () => {
  assert.equal(hasLocation({ lat: 4.6, lng: -74.08 }), true);
  assert.equal(hasLocation({ lat: 0, lng: 0 }), true);
  assert.equal(hasLocation({ lat: null, lng: null }), false);
  assert.equal(hasLocation({ lat: 4.6 }), false);
  assert.equal(hasLocation({ lat: 91, lng: 0 }), false);
  assert.equal(hasLocation(undefined), false);
});

test('placesFrom: ignora gastos sin ubicación y agrupa los cercanos', () => {
  const list = [
    { id: 'a', lat: 4.60971, lng: -74.08175, amount_home: 1000, amount_cents: 100, place: 'Centro' },
    { id: 'b', lat: 4.60980, lng: -74.08170, amount_home: 500, amount_cents: 50 },
    { id: 'c', lat: -22.9068, lng: -43.1729, amount_home: 200, amount_cents: 20 },
    { id: 'd', lat: null, lng: null, amount_home: 999, amount_cents: 99 },
  ];
  const places = placesFrom(list);
  assert.equal(places.length, 2);
  const centro = places.find((p) => p.count === 2);
  assert.equal(centro.total_home, 1500);
  assert.equal(centro.total_dest, 150);
  assert.equal(centro.place, 'Centro');
  assert.deepEqual(centro.ids, ['a', 'b']);
  assert.ok(Math.abs(centro.lat - 4.609755) < 1e-6);
});

test('placesFrom: gasto sin tasa suma 0 al total en moneda de casa', () => {
  const [p] = placesFrom([{ id: 'x', lat: 1, lng: 1, amount_home: null, amount_cents: 300 }]);
  assert.equal(p.total_home, 0);
  assert.equal(p.total_dest, 300);
});

test('formatCoords: 5 decimales', () => {
  assert.equal(formatCoords(4.609712, -74.081749), '4.60971, -74.08175');
});

test('routeFrom: paradas numeradas por primera visita y recorrido en orden de fecha', async () => {
  const { routeFrom } = await import('../public/js/places.mjs');
  const A = { lat: 4.6097, lng: -74.0817 };
  const B = { lat: 6.2442, lng: -75.5812 };
  const list = [
    // desordenados a propósito
    { id: '3', date: '2026-11-12', created_at: '1', ...A, amount_cents: 30, amount_home: 300 },
    { id: '1', date: '2026-11-10', created_at: '1', ...A, amount_cents: 10, amount_home: 100, place: 'Hotel' },
    { id: '2', date: '2026-11-10', created_at: '2', ...A, amount_cents: 20, amount_home: 200 },
    { id: '4', date: '2026-11-11', created_at: '1', ...B, amount_cents: 40, amount_home: 400 },
    { id: '5', date: '2026-11-11', created_at: '2', lat: null, lng: null, amount_cents: 1, amount_home: 1 },
  ];
  const { places, path } = routeFrom(list);
  assert.deepEqual(places.map((p) => [p.n, p.count, p.first_date, p.last_date]), [[1, 3, '2026-11-10', '2026-11-12'], [2, 1, '2026-11-11', '2026-11-11']]);
  assert.equal(places[0].place, 'Hotel');
  assert.deepEqual(places[0].ids, ['1', '2', '3']);
  // A (dos gastos seguidos = un punto), B, y la vuelta a A
  assert.equal(path.length, 3);
  assert.ok(Math.abs(path[0][0] - path[2][0]) < 1e-9);
  assert.ok(Math.abs(path[1][0] - 6.2442) < 1e-9);
});

test('routeFrom: sin ubicaciones no hay paradas ni recorrido', async () => {
  const { routeFrom } = await import('../public/js/places.mjs');
  assert.deepEqual(routeFrom([{ id: 'x', date: '2026-11-10' }]), { places: [], path: [] });
});
