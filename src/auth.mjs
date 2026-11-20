// Control de acceso: el código que llega en cada petición se convierte en un espacio.
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.mjs';
import { MANAGER_SPACE, findSpaceByCode, getPrincipalSpace, isInactiveSpaceCode, seedPrincipalCode } from './spaces.mjs';

const MAX_FAILS = 10;
const MAX_GLOBAL = 300;
const LOCK_MS = 15 * 60 * 1000;

const sha = (s) => createHash('sha256').update(String(s)).digest();

// ADMIN_PASSCODE y APP_PASSCODE se comparan exactos y en tiempo constante. Una variable vacía no es nada.
function isSecret(passcode, expected) {
  return Boolean(expected) && timingSafeEqual(sha(passcode ?? ''), sha(expected));
}

// La app pide código si está definida cualquiera de las dos: olvidar ADMIN_PASSCODE nunca la deja abierta.
const authEnabled = () => Boolean(process.env.ADMIN_PASSCODE || process.env.APP_PASSCODE);

// Este intento acertó: no cuenta contra la red ni contra el límite global.
async function forgiveAttempt(db, key) {
  await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', [key]);
  await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', ['global']);
}

// Agrupa las IPv6 por su prefijo /64 (un atacante suele controlar una red completa) y deja las IPv4 igual.
function ipKey(ip) {
  if (!ip) return 'desconocida';
  let v = String(ip).toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v;
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g || '0').join(':')}::/64`;
}

// Suma un intento de forma atómica (una sola sentencia, sin leer y luego escribir) y devuelve el total
// dentro de la ventana de bloqueo. Si la ventana venció, empieza de cero.
async function countAttempt(db, key, now) {
  const rows = await db.all(
    `INSERT INTO auth_failures (ip, fails, since) VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET
       fails = CASE WHEN ? - since >= ? THEN 1 ELSE fails + 1 END,
       since = CASE WHEN ? - since >= ? THEN ? ELSE since END
     RETURNING fails`,
    [key, now, now, LOCK_MS, now, LOCK_MS, now],
  );
  return Number(rows[0].fails);
}

// Devuelve la identidad a la que da acceso el código: la administración (ADMIN_PASSCODE) o un espacio de datos (por
// el hash de su código), con límite de intentos: por red (10 cada 15 min) y global (300 cada 15 min). Cada intento con
// código se cuenta ANTES de compararlo, así que aunque lleguen en paralelo solo se evalúan los primeros. Entrar sin
// código (primera visita) no cuenta. Compromiso: el límite global también permite que alguien bloquee a propósito por
// 15 minutos.
// Sin ADMIN_PASSCODE ni APP_PASSCODE la app está abierta (desarrollo local): sin código o con uno desconocido se entra
// a Principal, no hay administración y no se cuentan intentos.
export async function checkAuth(db, passcode, ip) {
  if (!authEnabled()) {
    return (passcode && (await findSpaceByCode(db, passcode))) || getPrincipalSpace(db);
  }
  if (!passcode) fail(401, 'Código incorrecto');
  const now = Date.now();
  const key = ipKey(ip);
  const [mine, all] = [await countAttempt(db, key, now), await countAttempt(db, 'global', now)];
  if (mine > MAX_FAILS || all > MAX_GLOBAL) fail(429, 'Demasiados intentos. Espera 15 minutos.');

  // La administración va primero: si ADMIN_PASSCODE coincide con el código de un espacio, gana la administración (que
  // no abre datos). Solo su acierto reinicia el contador de la red.
  if (isSecret(passcode, process.env.ADMIN_PASSCODE)) {
    await db.run('DELETE FROM auth_failures WHERE ip = ?', [key]);
    await db.run('UPDATE auth_failures SET fails = MAX(fails - 1, 0) WHERE ip = ?', ['global']);
    return MANAGER_SPACE;
  }
  let space = await findSpaceByCode(db, passcode);
  if (!space && isSecret(passcode, process.env.APP_PASSCODE)) {
    // Siembra de una sola vez: el APP_PASSCODE de siempre pasa a ser el código de Principal (si aún no tiene uno) y
    // desde ahí se reconoce por su hash, como cualquier espacio.
    await seedPrincipalCode(db, passcode);
    space = await findSpaceByCode(db, passcode);
  }
  if (space) {
    // Con el código de un espacio se descuenta solo este intento, para que un miembro de un grupo no pueda intercalar
    // aciertos entre sus intentos de adivinar ADMIN_PASSCODE y reiniciar así su límite.
    await forgiveAttempt(db, key);
    return space;
  }
  if (await isInactiveSpaceCode(db, passcode)) {
    // Quien lo manda tiene el código completo de un espacio que la administración desactivó: se le dice el motivo y
    // este intento no cuenta, para que un celular que sigue con ese código no se bloquee solo recargando.
    await forgiveAttempt(db, key);
    fail(403, 'Este espacio está desactivado. Habla con quien te dio el código.');
  }
  await db.run('DELETE FROM auth_failures WHERE since < ? AND ip != ?', [now - LOCK_MS, 'global']); // limpieza
  fail(401, 'Código incorrecto');
}
