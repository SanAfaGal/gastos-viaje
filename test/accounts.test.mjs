import test from 'node:test';
import assert from 'node:assert/strict';
import { abonoEffect, balanceBars, debtProgress, methodShares, owedBetween, quickAmounts } from '../public/js/accounts.mjs';
import { computeSettlement } from '../public/js/settlement.mjs';

const T = [{ from: 'ana', to: 'leo', amount: 582500 }];
const pay = (from, to, amount_home) => ({ from_person_id: from, to_person_id: to, amount_home });

test('owedBetween: lo que una persona le debe a otra, con signo según el sentido', () => {
  assert.equal(owedBetween(T, 'ana', 'leo'), 582500);
  assert.equal(owedBetween(T, 'leo', 'ana'), -582500);
  assert.equal(owedBetween(T, 'ana', 'eva'), 0);
  assert.equal(owedBetween([], 'ana', 'leo'), 0);
  assert.equal(owedBetween([...T, { from: 'eva', to: 'leo', amount: 100 }], 'ana', 'leo'), 582500); // otra deuda no se mezcla
});

test('debtProgress: lo abonado entre las dos personas y qué parte de la deuda original es', () => {
  const p = debtProgress(T[0], [pay('ana', 'leo', 595000)]);
  assert.deepEqual(p, { remaining: 582500, paid: 595000, total: 1177500, pct: 51 });
  assert.equal(debtProgress(T[0], []).pct, 0);
  assert.equal(debtProgress(T[0], []).total, 582500);
  // un abono en sentido contrario descuenta lo abonado; nunca queda negativo
  assert.equal(debtProgress(T[0], [pay('ana', 'leo', 100000), pay('leo', 'ana', 30000)]).paid, 70000);
  assert.equal(debtProgress(T[0], [pay('leo', 'ana', 30000)]).paid, 0);
  // sin tasa no cuenta, y los de otras personas tampoco
  assert.equal(debtProgress(T[0], [pay('ana', 'leo', null), pay('eva', 'leo', 5000)]).paid, 0);
  assert.equal(debtProgress({ from: 'a', to: 'b', amount: 0 }, []).pct, 0);
});

test('abonoEffect: queda a mano, sigue debiendo o se pasa', () => {
  const base = { owed: 582500, unit: 100 };
  assert.deepEqual(abonoEffect({ ...base, amount: 582500 }), { kind: 'square', rest: 0 });
  assert.deepEqual(abonoEffect({ ...base, amount: 291300 }), { kind: 'owes', rest: 291200 });
  assert.deepEqual(abonoEffect({ ...base, amount: 600000 }), { kind: 'over', rest: 17500 });
  // la diferencia menor a lo que se puede pagar cuenta como a mano
  assert.equal(abonoEffect({ ...base, amount: 582540 }).kind, 'square');
  // sin deuda en ese sentido, cualquier abono invierte la deuda
  assert.deepEqual(abonoEffect({ owed: 0, amount: 50000, unit: 100 }), { kind: 'over', rest: 50000 });
  assert.deepEqual(abonoEffect({ owed: -80000, amount: 50000, unit: 100 }), { kind: 'over', rest: 130000 });
  assert.equal(abonoEffect({ ...base, amount: undefined }).kind, 'none');
  assert.equal(abonoEffect({ ...base, amount: 0 }).kind, 'none');
  assert.equal(abonoEffect({ ...base, amount: null }).kind, 'unknown');
});

test('quickAmounts: todo y mitad, en lo que se puede pagar; sin deuda no hay montos', () => {
  assert.deepEqual(quickAmounts(582500, 100), { all: 582500, half: 291300 });
  assert.deepEqual(quickAmounts(1000, 100), { all: 1000, half: 500 });
  assert.deepEqual(quickAmounts(100, 100), { all: 100, half: 100 }); // la mitad nunca baja de una unidad
  assert.deepEqual(quickAmounts(0, 100), { all: 0, half: 0 });
  assert.deepEqual(quickAmounts(-500, 100), { all: 0, half: 0 });
});

test('balanceBars: el ancho es relativo al saldo mayor y cada lado lleva su signo', () => {
  const bars = balanceBars([{ person_id: 'a', net: -582500 }, { person_id: 'b', net: 582500 }, { person_id: 'c', net: 0 }]);
  assert.deepEqual(bars.map((b) => [b.side, b.pct]), [['neg', 100], ['pos', 100], ['zero', 0]]);
  const mixed = balanceBars([{ person_id: 'a', net: -1000000 }, { person_id: 'b', net: 10000 }]);
  assert.equal(mixed[0].pct, 100);
  assert.equal(mixed[1].pct, 6); // un saldo pequeño sigue viéndose
  assert.deepEqual(balanceBars([]), []);
  assert.equal(balanceBars([{ person_id: 'a', net: 0 }])[0].pct, 0);
});

test('methodShares: del mayor al menor con su porcentaje del total', () => {
  const rows = methodShares({ tar: 3000000, efe: 720000, pix: 5355000 }, ['tar', 'efe', 'pix', 'vacio']);
  assert.deepEqual(rows.map((r) => [r.id, r.pct]), [['pix', 59], ['tar', 33], ['efe', 8], ['vacio', 0]]);
  assert.deepEqual(methodShares({}, ['a']), [{ id: 'a', amount: 0, pct: 0 }]);
});

test('con el cálculo real de cuentas: el abono baja lo que falta y el avance coincide', () => {
  // Ana puso 30.000 (se divide entre 2) y Leo 53.550 (entre 2), en pesos: Ana le debe 11.775 a Leo.
  const expenses = [
    { amount_home: 3000000, payer_id: 'ana', beneficiary_ids: ['ana', 'leo'] },
    { amount_home: 5355000, payer_id: 'leo', beneficiary_ids: ['ana', 'leo'] },
  ];
  const before = computeSettlement(expenses, ['ana', 'leo'], 100);
  assert.deepEqual(before.transfers, [{ from: 'ana', to: 'leo', amount: 1177500 }]);
  const payments = [{ from: 'ana', to: 'leo', amount_home: 595000 }];
  const after = computeSettlement(expenses, ['ana', 'leo'], 100, payments);
  assert.deepEqual(after.transfers, [{ from: 'ana', to: 'leo', amount: 582500 }]);
  const prog = debtProgress(after.transfers[0], [pay('ana', 'leo', 595000)]);
  assert.equal(prog.total, 1177500); // lo que se debía antes de abonar
  assert.equal(prog.pct, 51);
  assert.equal(abonoEffect({ owed: owedBetween(after.transfers, 'ana', 'leo'), amount: 582500, unit: 100 }).kind, 'square');
});
