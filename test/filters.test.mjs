import test from 'node:test';
import assert from 'node:assert/strict';
import { PENDING, activeCount, applyFilters, filtersOff, isFiltered, keepValid } from '../public/js/filters.mjs';

const methodsById = {
  m1: { id: 'm1', owner_person_id: 'ana' },
  m2: { id: 'm2', owner_person_id: 'beto' },
  m3: { id: 'm3', owner_person_id: 'ana' },
};
const ex = (id, o = {}) => ({ id, date: '2026-11-10', description: id, payment_method_id: 'm1', beneficiary_ids: ['ana'], amount_home: 100, ...o });
const base = [
  ex('a'),
  ex('b', { date: '2026-11-11', payment_method_id: 'm2', beneficiary_ids: ['beto', 'ana'] }),
  ex('c', { payment_method_id: 'm3', beneficiary_ids: ['beto'] }),
  ex('d', { payment_method_id: null, amount_home: null }),
];
const ctx = { methodsById, hasLocation: (e) => e.id === 'a' };
const ids = (f) => applyFilters(base, { ...filtersOff(), ...f }, ctx).map((e) => e.id);

test('sin filtros pasan todos y cada llamada da arreglos nuevos', () => {
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.notEqual(filtersOff().method, filtersOff().method);
  assert.equal(isFiltered(filtersOff()), false);
  assert.equal(activeCount(filtersOff()), 0);
});

test('varias opciones del mismo filtro: pasa el que coincide con cualquiera', () => {
  assert.deepEqual(ids({ method: ['m1', 'm2'] }), ['a', 'b']);
  assert.deepEqual(ids({ day: ['2026-11-11', '2026-11-10'] }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ person: ['beto'] }), ['b', 'c']);
  assert.deepEqual(ids({ person: ['beto', 'ana'] }), ['a', 'b', 'c', 'd']);
});

test('"Por definir" se mezcla con medios concretos', () => {
  assert.deepEqual(ids({ method: [PENDING] }), ['d']);
  assert.deepEqual(ids({ method: [PENDING, 'm2'] }), ['b', 'd']);
});

test('quién pagó es el dueño del medio; sin medio no tiene pagador', () => {
  assert.deepEqual(ids({ payer: ['ana'] }), ['a', 'c']);
  assert.deepEqual(ids({ payer: ['ana', 'beto'] }), ['a', 'b', 'c']);
});

test('los filtros distintos se combinan con Y', () => {
  assert.deepEqual(ids({ payer: ['ana'], person: ['beto'] }), ['c']);
  assert.deepEqual(ids({ method: ['m1', 'm3'], day: ['2026-11-11'] }), []);
});

test('búsqueda, sin ubicación y tasa pendiente', () => {
  assert.deepEqual(ids({ q: ' B ' }), ['b']);
  assert.deepEqual(ids({ noloc: true }), ['b', 'c', 'd']);
  assert.deepEqual(ids({ rate: true }), ['d']);
});

test('cuántos filtros hay activos: cada uno cuenta 1 aunque tenga varias opciones', () => {
  const f = { ...filtersOff(), method: ['m1', 'm2', 'm3'], approx: true };
  assert.equal(activeCount(f), 2);
  assert.equal(isFiltered(f), true);
  assert.equal(isFiltered({ ...filtersOff(), q: '  ' }), false);
  assert.equal(isFiltered({ ...filtersOff(), q: 'x' }), true);
  assert.equal(activeCount({ ...filtersOff(), q: 'x' }), 0);
});

test('keepValid descarta lo que ya no existe', () => {
  assert.deepEqual(keepValid(['a', 'z'], ['a', 'b']), ['a']);
  assert.deepEqual(keepValid([], ['a']), []);
});

test('"sin monto": el filtro los encuentra y "tasa pendiente" no los confunde', () => {
  const list = [ex('a'), ex('n', { amount_pending: 1, amount_home: null }), ex('r', { amount_home: null })];
  const run = (f) => applyFilters(list, { ...filtersOff(), ...f }, ctx).map((e) => e.id);
  assert.deepEqual(run({ noamount: true }), ['n']);
  assert.deepEqual(run({ rate: true }), ['r']);
  assert.equal(isFiltered({ ...filtersOff(), noamount: true }), true);
  assert.equal(activeCount({ ...filtersOff(), noamount: true }), 1);
});
