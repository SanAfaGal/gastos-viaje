import test from 'node:test';
import assert from 'node:assert/strict';
import { compareChronological, compareExpenses, moveItem, sameOrder } from '../public/js/order.mjs';

const e = (id, date, created_at, sort_order) => ({ id, date, created_at, sort_order });

test('lista: días nuevos arriba y, dentro del día, el primero arriba', () => {
  const list = [e('b', '2026-11-10', '2'), e('c', '2026-11-11', '1'), e('a', '2026-11-10', '1')];
  assert.deepEqual([...list].sort(compareExpenses).map((x) => x.id), ['c', 'a', 'b']);
  assert.deepEqual([...list].sort(compareChronological).map((x) => x.id), ['a', 'b', 'c']);
});

test('orden manual manda sobre la hora; los nuevos sin orden van al final del día', () => {
  const list = [e('a', '2026-11-10', '1', 1), e('b', '2026-11-10', '2', 0), e('nuevo', '2026-11-10', '9', null), e('x', '2026-11-10', '3', undefined)];
  assert.deepEqual([...list].sort(compareExpenses).map((x) => x.id), ['b', 'a', 'x', 'nuevo']);
});

test('sin orden manual se respeta la hora de creación y, si empata, el id', () => {
  const list = [e('z', '2026-11-10', '1'), e('y', '2026-11-10', '1')];
  assert.deepEqual([...list].sort(compareExpenses).map((x) => x.id), ['y', 'z']);
});

test('moveItem y sameOrder', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  const base = ['a', 'b'];
  assert.deepEqual(moveItem(base, 0, 9), ['a', 'b']); // fuera de rango: igual
  assert.deepEqual(base, ['a', 'b']); // no toca el original
  assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameOrder(['a'], ['a', 'b']), false);
});
