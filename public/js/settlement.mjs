// Cuentas finales. Módulo puro: el servidor y el navegador (sin internet) usan el mismo código.
//
// Entrada: gastos con { amount_home, payer_id, beneficiary_ids }.
//   payer_id = dueño del medio de pago (quien puso la plata).
//   beneficiary_ids = personas para quienes fue el gasto, en partes iguales.
// Los gastos sin amount_home (tasa pendiente) no entran al cálculo y se cuentan aparte.

// Reparte `total` pesos enteros entre `ids`; el sobrante se reparte de a 1 peso en orden de id.
export function splitEqual(total, ids) {
  const sorted = [...ids].sort();
  const base = Math.floor(total / sorted.length);
  let rest = total - base * sorted.length;
  const out = {};
  for (const id of sorted) {
    out[id] = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest -= 1;
  }
  return out;
}

// `unit` = menor fracción que se paga en tu moneda, en centésimas (COP: 100 = un peso; USD: 1 = un centavo).
// Así los repartos quedan en pesos enteros y no en fracciones que no se pueden pagar.
export function computeSettlement(expenses, personIds = [], unit = 1) {
  const paid = {};
  const consumed = {};
  for (const id of personIds) {
    paid[id] = 0;
    consumed[id] = 0;
  }
  let pending = 0;
  for (const e of expenses) {
    if (e.amount_home == null) {
      pending += 1;
      continue;
    }
    const total = Math.round(e.amount_home / unit);
    paid[e.payer_id] = (paid[e.payer_id] ?? 0) + total;
    const parts = splitEqual(total, e.beneficiary_ids);
    for (const [id, v] of Object.entries(parts)) consumed[id] = (consumed[id] ?? 0) + v;
  }
  const ids = new Set([...Object.keys(paid), ...Object.keys(consumed)]);
  const balances = [...ids].map((person_id) => ({
    person_id,
    paid: paid[person_id] ?? 0,
    consumed: consumed[person_id] ?? 0,
    net: (paid[person_id] ?? 0) - (consumed[person_id] ?? 0),
  }));
  const scale = (n) => n * unit;
  return {
    balances: balances.map((b) => ({ ...b, paid: scale(b.paid), consumed: scale(b.consumed), net: scale(b.net) })),
    transfers: minTransfers(balances).map((t) => ({ ...t, amount: scale(t.amount) })),
    pending,
  };
}

// Mayor deudor paga al mayor acreedor hasta saldar. Deja pocos pagos.
export function minTransfers(balances) {
  const creditors = balances.filter((b) => b.net > 0).map((b) => ({ id: b.person_id, left: b.net }));
  const debtors = balances.filter((b) => b.net < 0).map((b) => ({ id: b.person_id, left: -b.net }));
  const byLeft = (a, b) => b.left - a.left || a.id.localeCompare(b.id);
  const transfers = [];
  while (creditors.length && debtors.length) {
    creditors.sort(byLeft);
    debtors.sort(byLeft);
    const c = creditors[0];
    const d = debtors[0];
    const amount = Math.min(c.left, d.left);
    transfers.push({ from: d.id, to: c.id, amount });
    c.left -= amount;
    d.left -= amount;
    if (c.left === 0) creditors.shift();
    if (d.left === 0) debtors.shift();
  }
  return transfers;
}
