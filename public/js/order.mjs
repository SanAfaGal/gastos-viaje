// Orden de los gastos. Módulo puro (sin DOM): lo usan el navegador y las pruebas.
//
// Los días van del más reciente al más antiguo. Dentro de un día el orden es cronológico: primero el que
// se hizo antes. Si el día se ordenó a mano (sort_order), manda ese orden; los gastos nuevos, que aún no
// tienen sort_order, van al final del día por su hora de creación.

// Orden dentro de un mismo día.
export function compareInDay(a, b) {
  const ao = a.sort_order ?? null;
  const bo = b.sort_order ?? null;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if ((ao == null) !== (bo == null)) return ao == null ? 1 : -1;
  return String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id));
}

// Para la lista: días nuevos arriba, dentro del día cronológico.
export const compareExpenses = (a, b) => (a.date === b.date ? compareInDay(a, b) : String(b.date).localeCompare(String(a.date)));

// Del más antiguo al más reciente (CSV, mapa).
export const compareChronological = (a, b) => (a.date === b.date ? compareInDay(a, b) : String(a.date).localeCompare(String(b.date)));

// Mueve el elemento de la posición `from` a la posición `to` sin tocar el arreglo original.
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// ¿Cambió el orden? (para no enviar nada si se soltó donde estaba)
export const sameOrder = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
