// Filtros del listado de gastos. Módulo puro (sin DOM): lo usan el navegador y las pruebas.
//
// Los filtros de lista (día, medio de pago, para quién, quién pagó) admiten varias opciones a la vez: un gasto
// pasa si coincide con CUALQUIERA de las elegidas (con la lista vacía no se filtra por ese criterio).

export const PENDING = 'pending'; // "Por definir": gasto sin medio de pago

export const MULTI_KEYS = ['day', 'method', 'person', 'payer'];
const FLAG_KEYS = ['approx', 'noloc', 'rate', 'noamount'];

// Una función y no una constante: así cada vez salen arreglos nuevos y no se comparte una misma referencia.
export const filtersOff = () => ({ q: '', day: [], method: [], person: [], payer: [], approx: false, noloc: false, rate: false, noamount: false });

const any = (sel) => sel.length > 0;

// `ctx` = { methodsById, hasLocation }.
export function applyFilters(expenses, f, { methodsById, hasLocation }) {
  const q = f.q.trim().toLowerCase();
  return expenses.filter((e) =>
    (!q || e.description.toLowerCase().includes(q)) &&
    (!any(f.method) || f.method.includes(e.payment_method_id == null ? PENDING : e.payment_method_id)) &&
    (!any(f.person) || e.beneficiary_ids.some((id) => f.person.includes(id))) &&
    (!any(f.payer) || f.payer.includes(methodsById[e.payment_method_id]?.owner_person_id)) &&
    (!any(f.day) || f.day.includes(e.date)) &&
    (!f.approx || e.amount_approx) &&
    (!f.noloc || !hasLocation(e)) &&
    // "Tasa pendiente o estimada": un gasto sin monto no espera la tasa, espera el monto (su propio filtro).
    (!f.rate || (!e.amount_pending && (e.amount_home == null || e.rate_estimated))) &&
    (!f.noamount || Boolean(e.amount_pending)));
}

// ¿Hay algún filtro puesto? (incluida la búsqueda de texto)
export const isFiltered = (f) => f.q.trim() !== '' || MULTI_KEYS.some((k) => any(f[k])) || FLAG_KEYS.some((k) => f[k]);

// Filtros del panel (sin contar la búsqueda, que se ve aparte): cada uno cuenta 1 aunque tenga varias opciones.
export const activeCount = (f) => MULTI_KEYS.filter((k) => any(f[k])).length + FLAG_KEYS.filter((k) => f[k]).length;

// Quita de una selección lo que ya no existe (por ejemplo un día cuyos gastos se borraron).
export const keepValid = (sel, valid) => sel.filter((v) => valid.includes(v));
