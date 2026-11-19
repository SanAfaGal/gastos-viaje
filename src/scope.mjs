// A qué espacio pertenece una fila. Personas, viajes y medios de pago tienen su space_id; los gastos y los abonos
// pertenecen al espacio de su viaje. Una fila cuyo viaje no existe no es de ningún espacio (cuenta como ajena).
import { fail } from './errors.mjs';

// Lista cerrada: `table` nunca llega de la petición, pero igual se valida porque se arma SQL con este texto.
const SPACE_OF = {
  people: { from: 'people x', space: 'x.space_id' },
  trips: { from: 'trips x', space: 'x.space_id' },
  payment_methods: { from: 'payment_methods x', space: 'x.space_id' },
  expenses: { from: 'expenses x LEFT JOIN trips t ON t.id = x.trip_id', space: 't.space_id' },
  payments: { from: 'payments x LEFT JOIN trips t ON t.id = x.trip_id', space: 't.space_id' },
};

// Tope de ids por consulta, por debajo del máximo de parámetros de SQLite.
const CHUNK = 500;

function source(table, sp) {
  if (typeof table !== 'string' || !Object.hasOwn(SPACE_OF, table)) throw new Error(`Tabla no permitida: ${table}`);
  if (typeof sp !== 'string' || !sp) throw new Error('Falta el espacio');
  return SPACE_OF[table];
}

// Los ids se comparan como texto (las columnas id son TEXT y SQLite convierte un número a texto al comparar),
// así que un id numérico del cliente se busca igual que el texto con que quedaría guardado.
const key = (id) => (id == null ? '' : String(id));

// Para cada id que existe, el espacio al que pertenece (null si su viaje no existe).
async function spacesOf(db, table, ids) {
  const { from, space } = SPACE_OF[table];
  const wanted = [...new Set(ids.map(key).filter(Boolean))];
  const found = new Map();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const part = wanted.slice(i, i + CHUNK);
    const rows = await db.all(`SELECT x.id AS id, ${space} AS sp FROM ${from} WHERE x.id IN (${part.map(() => '?').join(',')})`, part);
    for (const r of rows) found.set(r.id, r.sp ?? null);
  }
  return found;
}

// La fila existe y es del espacio `sp`.
export async function owns(db, table, id, sp) {
  source(table, sp);
  return (await spacesOf(db, table, [id])).get(key(id)) === sp;
}

// Falla con 404 si la fila existe y es de otro espacio. Si no existe o es propia, no hace nada.
// Se usa antes de un INSERT ... ON CONFLICT con un id elegido por el cliente.
export async function assertNotForeign(db, table, id, sp) {
  source(table, sp);
  const found = await spacesOf(db, table, [id]);
  if (found.has(key(id)) && found.get(key(id)) !== sp) fail(404, 'No encontrado');
}

// Cuáles de `ids` existen y son del espacio `sp`.
export async function ownedIds(db, table, ids, sp) {
  source(table, sp);
  const found = await spacesOf(db, table, Array.isArray(ids) ? ids : []);
  return new Set([...found].filter(([, s]) => s === sp).map(([id]) => id));
}
