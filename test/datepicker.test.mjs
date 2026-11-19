import test from 'node:test';
import assert from 'node:assert/strict';
import { monthCells } from '../public/js/datepicker.mjs';

test('calendario: cuadrícula del mes desde el lunes, con hoy, el día marcado y los días futuros apagados', () => {
  // Noviembre de 2026 empieza en domingo: seis celdas vacías antes del día 1 (semana desde el lunes) y 30 días.
  const cells = monthCells(2026, 10, { value: '2026-11-10', min: '2000-01-01', max: '2026-11-18', today: '2026-11-18' });
  assert.equal(cells.filter((c) => c === null).length, 6);
  assert.equal(cells.filter(Boolean).length, 30);
  const day = (n) => cells.find((c) => c?.d === n);
  assert.equal(day(10).sel, true);
  assert.equal(day(18).today, true);
  assert.equal(day(18).off, false);
  assert.equal(day(19).off, true); // después de hoy no se puede elegir
  assert.equal(day(1).date, '2026-11-01');
  // Febrero bisiesto de 2028 tiene 29 días.
  assert.equal(monthCells(2028, 1, { value: '', min: '2000-01-01', max: '2030-01-01', today: '' }).filter(Boolean).length, 29);
});
