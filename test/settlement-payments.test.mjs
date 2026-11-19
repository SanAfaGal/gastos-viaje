import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement } from '../public/js/settlement.mjs';

const expenses = [{ amount_home: 10000, payer_id: 'ana', beneficiary_ids: ['ana', 'leo'] }]; // Leo le debe 5000 a Ana

test('abonos: descuentan lo que se deben y dejan el saldo en cero cuando se paga todo', () => {
  assert.deepEqual(computeSettlement(expenses, ['ana', 'leo']).transfers, [{ from: 'leo', to: 'ana', amount: 5000 }]);

  const parcial = computeSettlement(expenses, ['ana', 'leo'], 1, [{ from: 'leo', to: 'ana', amount_home: 2000 }]);
  assert.deepEqual(parcial.transfers, [{ from: 'leo', to: 'ana', amount: 3000 }]);
  const leo = parcial.balances.find((b) => b.person_id === 'leo');
  assert.deepEqual([leo.net, leo.settled], [-3000, 2000]);
  const ana = parcial.balances.find((b) => b.person_id === 'ana');
  assert.deepEqual([ana.net, ana.settled], [3000, -2000]);

  const total = computeSettlement(expenses, ['ana', 'leo'], 1, [
    { from: 'leo', to: 'ana', amount_home: 3000 },
    { from: 'leo', to: 'ana', amount_home: 2000 },
  ]);
  assert.deepEqual(total.transfers, []);
  assert.deepEqual(total.balances.map((b) => b.net), [0, 0]);
});

test('abonos: un sobrepago invierte la deuda, el que no tiene tasa se cuenta aparte y la unidad redondea', () => {
  const sobre = computeSettlement(expenses, ['ana', 'leo'], 1, [{ from: 'leo', to: 'ana', amount_home: 6000 }]);
  assert.deepEqual(sobre.transfers, [{ from: 'ana', to: 'leo', amount: 1000 }]);

  const sinTasa = computeSettlement(expenses, ['ana', 'leo'], 1, [{ from: 'leo', to: 'ana', amount_home: null }]);
  assert.equal(sinTasa.pendingPayments, 1);
  assert.deepEqual(sinTasa.transfers, [{ from: 'leo', to: 'ana', amount: 5000 }]); // no descuenta hasta tener tasa

  // Con unidad 100 (COP: los montos van en centésimas), un abono de 1.234,56 cuenta como 1.235 pesos.
  const big = [{ amount_home: 1000000, payer_id: 'ana', beneficiary_ids: ['ana', 'leo'] }];
  const unit = computeSettlement(big, ['ana', 'leo'], 100, [{ from: 'leo', to: 'ana', amount_home: 123456 }]);
  assert.deepEqual(unit.transfers, [{ from: 'leo', to: 'ana', amount: 376500 }]);
});

test('abonos: sin abonos el resultado es el de siempre', () => {
  const a = computeSettlement(expenses, ['ana', 'leo']);
  assert.equal(a.pendingPayments, 0);
  assert.deepEqual(a.balances.map((b) => b.settled), [0, 0]);
});
