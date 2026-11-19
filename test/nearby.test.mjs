import test from 'node:test';
import assert from 'node:assert/strict';
import { knownPlaces, recentPlaces, visitedPlaces } from '../public/js/nearby.mjs';

const REF = { lat: -8.05, lng: -34.9 };
// ~0.000009° de latitud = 1 m
const at = (m, extra = {}) => ({ lat: REF.lat + m * 0.000009, lng: REF.lng, ...extra });
const exp = (id, date, m, place, extra = {}) => ({ id, date, created_at: `${date}T10:00:00Z`, place, ...at(m), ...extra });

test('knownPlaces: gastos a pocos metros son el mismo lugar y devuelve las coordenadas del más reciente', () => {
  const list = knownPlaces([
    exp(1, '2026-11-01', 5, 'Foco'),
    exp(2, '2026-11-03', 25, 'Foco'),
    exp(3, '2026-11-02', 10, ''),
  ], REF);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Foco');
  assert.equal(list[0].count, 3);
  assert.equal(list[0].lat, at(25).lat); // exacto, no un promedio
});

test('knownPlaces: toma el nombre más usado, ordena por cercanía y respeta el radio', () => {
  const list = knownPlaces([
    exp(1, '2026-11-01', 90, 'Lejos'),
    exp(2, '2026-11-01', 10, 'A'),
    exp(3, '2026-11-02', 11, 'B'),
    exp(4, '2026-11-03', 12, 'B'),
    exp(5, '2026-11-01', 400, 'Muy lejos'),
    { id: 6, date: '2026-11-01', lat: null, lng: null, place: 'Sin ubicación' },
  ], REF);
  assert.deepEqual(list.map((p) => p.name), ['B', 'Lejos']);
  assert.ok(list[0].km < list[1].km);
});

test('knownPlaces: sin gastos con ubicación no hay candidatos', () => {
  assert.deepEqual(knownPlaces([], REF), []);
  assert.deepEqual(knownPlaces([{ id: 1, date: '2026-11-01', lat: null, lng: null }], REF), []);
});

test('recientes: los del mismo día primero, luego del más nuevo al más viejo; un lugar con varios gastos sale una vez', () => {
  const recent = recentPlaces([
    exp(1, '2026-11-10', 5, 'Foco'),
    exp(2, '2026-11-12', 500, 'Padaria'),
    exp(3, '2026-11-12', 504, 'Padaria', { created_at: '2026-11-12T18:00:00Z' }), // mismo lugar, otro pago
    exp(4, '2026-11-15', 1000, 'Museo'),
    exp(5, '2026-11-12', 2000, ''),
    { id: 6, date: '2026-11-16', lat: null, lng: null, place: 'Sin ubicación' },
  ], { date: '2026-11-12' });
  assert.deepEqual(recent.map((p) => p.name), ['Padaria', '', 'Museo', 'Foco']); // los de ese día primero (Padaria más nueva), luego Museo y Foco
  assert.deepEqual(recent.map((p) => p.today), [true, true, false, false]);
  assert.equal(recent[0].count, 2);
  assert.equal(recent[0].lat, at(504).lat); // coordenadas del gasto más reciente
});

test('recientes: sin fecha se ordena por lo más nuevo y se respeta el límite', () => {
  const list = [1, 2, 3, 4, 5, 6, 7].map((n) => exp(n, `2026-11-0${n}`, n * 300, `L${n}`));
  const r = recentPlaces(list, { limit: 3 });
  assert.deepEqual(r.map((p) => p.name), ['L7', 'L6', 'L5']);
  assert.ok(r.every((p) => p.today === false));
  assert.deepEqual(recentPlaces([]), []);
});

test('visitedPlaces: todos los lugares del viaje, del más reciente al más antiguo, sin repetir el mismo sitio', () => {
  const expenses = [
    exp(1, '2026-11-01', 0, 'Foco'),
    exp(2, '2026-11-05', 4, 'Foco'), // a 4 m: es el mismo lugar
    exp(3, '2026-11-03', 500, 'Panadería Pão Quente'),
    exp(4, '2026-11-02', 1000, 'Playa de Boa Viagem'),
    exp(5, '2026-11-04', 1500, ''), // sin nombre: sale igual
    { id: 6, date: '2026-11-06', created_at: '2026-11-06T10:00:00Z', place: 'Sin ubicación', lat: null, lng: null }, // sin ubicación: no cuenta
  ];
  const list = visitedPlaces(expenses);
  assert.deepEqual(list.map((p) => p.name), ['Foco', '', 'Panadería Pão Quente', 'Playa de Boa Viagem']);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].last, '2026-11-05');
  assert.equal(list[0].lat, at(4).lat); // las coordenadas del gasto más reciente
  assert.deepEqual(visitedPlaces([]), []);
});

test('visitedPlaces: la búsqueda ignora acentos y mayúsculas, y lo que empieza por lo escrito va primero', () => {
  const expenses = [
    exp(1, '2026-11-09', 0, 'Supermercado Pão de Açúcar'),
    exp(2, '2026-11-01', 500, 'Açaí da Praia'),
    exp(3, '2026-11-05', 1000, 'Padaria Estação'),
    exp(4, '2026-11-07', 1500, 'Casa de la Praia'),
  ];
  assert.deepEqual(visitedPlaces(expenses, { query: 'acai' }).map((p) => p.name), ['Açaí da Praia']);
  assert.deepEqual(visitedPlaces(expenses, { query: 'PÃO' }).map((p) => p.name), ['Supermercado Pão de Açúcar']);
  // Ninguno empieza por 'praia': quedan los dos que lo contienen, el más reciente primero.
  assert.deepEqual(visitedPlaces(expenses, { query: 'praia' }).map((p) => p.name), ['Casa de la Praia', 'Açaí da Praia']);
  // Empieza por lo escrito primero, aunque sea más antiguo.
  assert.equal(visitedPlaces(expenses, { query: 'pa' }).map((p) => p.name)[0], 'Padaria Estação');
  assert.deepEqual(visitedPlaces(expenses, { query: 'zzz' }), []);
  assert.equal(visitedPlaces(expenses, { query: '   ' }).length, 4); // solo espacios = sin filtro
});
