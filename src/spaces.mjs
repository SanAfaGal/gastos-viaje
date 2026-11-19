// Espacios: cada código de acceso abre su propio espacio con sus propios datos.
import { createHash, randomInt } from 'node:crypto';
import { ADMIN_SPACE_ID } from './db.mjs';

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
  const rows = await db.all('SELECT id, name, is_admin FROM spaces WHERE code_hash = ? AND active = 1', [hashCode(raw)]);
  return rows.length ? toSpace(rows[0]) : null;
}

// El espacio administrador: existe siempre (lo crea la migración) y no cambia al cambiar APP_PASSCODE.
export async function getAdminSpace(db) {
  const rows = await db.all('SELECT id, name, is_admin FROM spaces WHERE id = ?', [ADMIN_SPACE_ID]);
  return toSpace(rows[0]);
}
