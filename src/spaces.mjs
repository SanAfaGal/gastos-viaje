// Espacios: cada código de acceso abre su propio espacio con sus propios datos.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { ADMIN_SPACE_ID } from './db.mjs';
import { fail, text } from './errors.mjs';
import { DEFAULT_SETTINGS } from '../public/js/currencies.mjs';

export { ADMIN_SPACE_ID };

// Sin 0, O, 1, I ni L para que el código se pueda leer y dictar sin confundirse.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Código nuevo con forma XXXX-XXXX-XXXX (12 caracteres al azar).
export function generateCode() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

// Quita todo lo que no sea letra o número y pasa a mayúsculas: "k7m4-x9qd h2rt" == "K7M4X9QDH2RT".
export function normalizeCode(raw) {
  return String(raw ?? '').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
}

export function hashCode(raw) {
  return createHash('sha256').update(normalizeCode(raw)).digest('hex');
}

const toSpace = (row) => ({ id: row.id, name: row.name, is_admin: Number(row.is_admin) === 1 });

// Espacio activo que corresponde al código, o null. Los desactivados no entran.
export async function findSpaceByCode(db, raw) {
  if (!normalizeCode(raw)) return null; // un código que se reduce a vacío ("---", un salto de línea) nunca se busca
  const rows = await db.all('SELECT id, name, is_admin FROM spaces WHERE code_hash = ? AND active = 1', [hashCode(raw)]);
  return rows.length ? toSpace(rows[0]) : null;
}

// ¿Es el código EXACTO de un espacio desactivado? Solo lo sabe quien ya tiene el código completo (12 caracteres al
// azar), así que decírselo no le revela nada: le explica por qué no entra, en vez de un "código incorrecto".
export async function isInactiveSpaceCode(db, raw) {
  if (!normalizeCode(raw)) return false;
  const rows = await db.all('SELECT 1 AS x FROM spaces WHERE code_hash = ? AND active = 0 AND is_admin = 0', [hashCode(raw)]);
  return rows.length > 0;
}

// El espacio administrador: existe siempre (lo crea la migración) y no cambia al cambiar APP_PASSCODE.
export async function getAdminSpace(db) {
  const rows = await db.all('SELECT id, name, is_admin FROM spaces WHERE id = ?', [ADMIN_SPACE_ID]);
  return toSpace(rows[0]);
}

// ---------- administración (solo el espacio administrador llega aquí, ver handlers.mjs) ----------

const INTENTOS_DE_CODIGO = 5;
const esColision = (err) => /UNIQUE/i.test(String(err?.message));

// Ejecuta `escribir(code, hash)` con un código nuevo; si el índice único de code_hash lo rechaza, genera otro.
// En la base solo entra el hash: el código en claro se devuelve una vez y no se guarda.
async function conCodigoNuevo(escribir) {
  for (let intento = 1; ; intento += 1) {
    const code = generateCode();
    try {
      await escribir(hashCode(code));
      return code;
    } catch (err) {
      if (!esColision(err) || intento >= INTENTOS_DE_CODIGO) throw err;
    }
  }
}

// Nunca selecciona code_hash. El administrador va primero y luego por fecha de creación.
export async function listSpaces(db) {
  const rows = await db.all('SELECT id, name, created_at, active, is_admin FROM spaces ORDER BY is_admin DESC, created_at, rowid');
  return rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at, active: Number(r.active) === 1, is_admin: Number(r.is_admin) === 1 }));
}

// Crea el espacio y su viaje inicial en una sola transacción: no puede quedar un espacio a medias.
export async function createSpace(db, body) {
  const name = text(body?.name, 'El nombre', { max: 40 });
  const id = randomUUID();
  const now = new Date().toISOString();
  const code = await conCodigoNuevo((hash) => db.batch([
    { sql: 'INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, 1, ?)', args: [id, name, hash, now] },
    {
      sql: 'INSERT INTO trips (id, name, dest_currency, home_currency, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?)',
      args: [randomUUID(), 'Viaje 1', DEFAULT_SETTINGS.dest, DEFAULT_SETTINGS.home, now, id],
    },
  ]));
  return { id, name, code };
}

// Espacio que se puede cambiar: existe y no es el administrador.
async function spaceEditable(db, id) {
  const rows = await db.all('SELECT id, is_admin FROM spaces WHERE id = ?', [id]);
  if (!rows.length) fail(404, 'No encontrado');
  if (Number(rows[0].is_admin) === 1) fail(400, 'El espacio administrador no se puede cambiar');
}

// Código nuevo para el espacio: el anterior deja de servir.
export async function regenerateSpace(db, id) {
  await spaceEditable(db, id);
  const code = await conCodigoNuevo((hash) => db.run('UPDATE spaces SET code_hash = ? WHERE id = ? AND is_admin = 0', [hash, id]));
  return { id, code };
}

// Desactivar no borra nada: el espacio solo deja de entrar hasta que se reactive.
export async function setSpaceActive(db, id, body) {
  if (typeof body?.active !== 'boolean') fail(400, 'active debe ser verdadero o falso');
  await spaceEditable(db, id);
  await db.run('UPDATE spaces SET active = ? WHERE id = ? AND is_admin = 0', [body.active ? 1 : 0, id]);
  return { id, active: body.active };
}
