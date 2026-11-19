// Lógica sin DOM de Cuentas y del abono: cuánto se deben dos personas, el avance de una deuda y qué pasa al abonar.
// Todos los montos son enteros en centésimas de la moneda de casa (los mismos que devuelve computeSettlement).

// Lo que `from` le debe hoy a `to` según las transferencias sugeridas. Positivo: `from` le debe a `to`. Negativo: es `to` quien le debe a
// `from`. Cero: no se deben nada entre sí.
export const owedBetween = (transfers, from, to) => transfers.reduce((n, t) => {
  if (t.from === from && t.to === to) return n + t.amount;
  if (t.from === to && t.to === from) return n - t.amount;
  return n;
}, 0);

// Avance de una deuda sugerida t = { from, to, amount }, donde `amount` es lo que FALTA. Lo abonado entre esas dos personas se resta de lo
// abonado en sentido contrario. Un abono sin tasa (amount_home null) todavía no cuenta. total = lo que se debía antes de abonar.
export function debtProgress(t, payments = []) {
  let paid = 0;
  for (const p of payments) {
    if (p.amount_home == null) continue;
    if (p.from_person_id === t.from && p.to_person_id === t.to) paid += p.amount_home;
    else if (p.from_person_id === t.to && p.to_person_id === t.from) paid -= p.amount_home;
  }
  paid = Math.max(0, paid);
  const total = t.amount + paid;
  return { remaining: t.amount, paid, total, pct: total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0 };
}

// Qué pasa con la deuda entre `from` y `to` si se abona `amount`. `owed` = lo que `from` le debe hoy a `to` (negativo: al revés). `unit` = la
// menor fracción que se puede pagar (COP: 100 = un peso). Devuelve { kind, rest }:
//  - 'none': todavía no hay monto;  - 'unknown': el monto no se pudo convertir (sin tasa);  - 'square': quedan a mano;
//  - 'owes': `from` sigue debiendo `rest`;  - 'over': el abono se pasa y ahora `to` le debe `rest` a `from`.
export function abonoEffect({ owed, amount, unit = 1 }) {
  if (amount === undefined || amount === 0) return { kind: 'none', rest: 0 };
  if (amount === null) return { kind: 'unknown', rest: 0 };
  const after = Math.round((owed - amount) / unit) * unit;
  if (after === 0) return { kind: 'square', rest: 0 };
  return after > 0 ? { kind: 'owes', rest: after } : { kind: 'over', rest: -after };
}

// Montos rápidos del diálogo: todo lo que se debe, y la mitad redondeada a lo que se puede pagar. Sin deuda en ese sentido no hay "todo".
export function quickAmounts(owed, unit = 1) {
  if (!(owed > 0)) return { all: 0, half: 0 };
  return { all: owed, half: Math.max(unit, Math.round(owed / 2 / unit) * unit) };
}

// Barras del saldo por persona: el ancho es relativo al saldo más grande (las deudas hacia un lado, lo que les deben hacia el otro).
export function balanceBars(balances) {
  const max = Math.max(0, ...balances.map((b) => Math.abs(b.net)));
  return balances.map((b) => ({
    person_id: b.person_id,
    net: b.net,
    side: b.net < 0 ? 'neg' : b.net > 0 ? 'pos' : 'zero',
    pct: b.net === 0 || max === 0 ? 0 : Math.max(6, Math.round((Math.abs(b.net) / max) * 100)),
  }));
}

// Gasto por medio de pago: del mayor al menor, con su parte del total.
export function methodShares(byMethod, ids) {
  const rows = ids.map((id) => ({ id, amount: byMethod[id] ?? 0 }));
  const total = rows.reduce((n, r) => n + r.amount, 0);
  return rows.map((r) => ({ ...r, pct: total > 0 ? Math.round((r.amount / total) * 100) : 0 })).sort((a, b) => b.amount - a.amount);
}
