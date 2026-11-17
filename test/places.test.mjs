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
