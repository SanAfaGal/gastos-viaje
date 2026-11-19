import test from 'node:test';
import assert from 'node:assert/strict';
import { buildList, confirmPlace, selectionSummary } from '../public/js/picker.mjs';

const REF = { lat: -8.05, lng: -34.9 };
const at = (m, extra = {}) => ({ lat: REF.lat + m * 0.000009, lng: REF.lng, ...extra });

test('lista: "Este punto" primero y luego los lugares usados numerados', () => {
  const items = buildList({
    anchor: { ...at(0), source: 'tap' },
    known: [{ name: 'Casa', ...at(5), km: 0.005, count: 2 }, { name: 'Bar', ...at(20), km: 0.02, count: 1 }],
    typed: 'Mi punto',
  });
  assert.deepEqual(items.map((i) => i.kind), ['point', 'known', 'known']);
  assert.deepEqual(items.map((i) => i.n), [undefined, 1, 2]);
  assert.equal(new Set(items.map((i) => i.key)).size, 3); // llaves únicas para reconocer la fila elegida
  assert.equal(items[0].name, 'Mi punto');
  assert.deepEqual(buildList({ anchor: null }), []);
  assert.equal(buildList({ anchor: null, known: [{ name: 'Casa', ...at(5), count: 1 }] }).length, 1); // sin ancla también salen los usados
});

test('resumen del pie: nombre, o de dónde sale el punto con coordenadas', () => {
  assert.equal(selectionSummary(null).title, 'Nada elegido');
  assert.equal(selectionSummary({ kind: 'point', name: '', lat: 1, lng: 2, source: 'tap' }).title, 'Punto del mapa');
  assert.equal(selectionSummary({ kind: 'point', name: '', lat: 1, lng: 2, source: 'coords' }).title, 'Desde Google Maps');
  const named = selectionSummary({ kind: 'point', name: 'Mi tienda', lat: -8.22424, lng: -34.92927, source: 'tap' });
  assert.equal(named.title, 'Mi tienda');
  assert.match(named.sub, /^Punto del mapa · -8\.22424/);
  assert.equal(selectionSummary({ kind: 'point', name: '', lat: 1, lng: 2, source: 'recent' }).title, 'Lugar reciente');
  assert.deepEqual(selectionSummary({ kind: 'known', name: 'Bar', detail: 'Beer Garden · Rua A', lat: 1, lng: 2 }), { title: 'Bar', sub: 'Beer Garden · Rua A' });
  assert.equal(selectionSummary({ kind: 'known', name: '', lat: 1, lng: 2 }).title, 'Sin nombre');
  assert.equal(selectionSummary({ kind: 'known', name: 'X', lat: 1, lng: 2 }).sub, 'Lugar que ya usaste');
});

test('nombre al confirmar: el elegido o escrito gana aunque ya hubiera otro; sin nombre se conserva', () => {
  assert.equal(confirmPlace('Viejo', { name: 'Nuevo' }), 'Nuevo');
  assert.equal(confirmPlace('', { name: '  Edf. X  ' }), 'Edf. X');
  assert.equal(confirmPlace('Viejo', { name: '' }), 'Viejo');
  assert.equal(confirmPlace(undefined, { name: '' }), '');
  assert.equal(confirmPlace('', { name: 'x'.repeat(200) }).length, 120);
});
