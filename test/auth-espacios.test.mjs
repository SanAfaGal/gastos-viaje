// Límite de intentos con códigos de espacio: acertar con el código de un grupo no le regala intentos a esa red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';

delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const ADMIN = 'codigo-largo-del-administrador';
const CODE = 'AAAA-BBBB-CCCC';

async function base() {
  const db = await openMemoryDb();
  await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, 1, ?)', ['space-a', 'Grupo A', hashCode(CODE), new Date().toISOString()]);
  return db;
}

// Con ADMIN_PASSCODE definido (sin APP_PASSCODE); deja las dos variables como estaban.
async function conPasscode(fn) {
  const antes = { ADMIN_PASSCODE: process.env.ADMIN_PASSCODE, APP_PASSCODE: process.env.APP_PASSCODE };
  const poner = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  poner('ADMIN_PASSCODE', ADMIN);
  poner('APP_PASSCODE', undefined);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) poner(k, v);
  }
}

const llamar = (db, passcode, ip = '1.1.1.1') => handle({ method: 'GET', path: '/api/ping', passcode, ip, db }).then((r) => r.status);

test('aciertos con un código de espacio intercalados no reinician el contador de la red: el undécimo fallo es 429', () => conPasscode(async () => {
  const db = await base();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await llamar(db, 'adivinanza'), 401, `fallo ${i + 1}`);
    if (i < 9) assert.equal(await llamar(db, CODE), 200, 'el código del grupo sigue entrando');
  }
  assert.equal(await llamar(db, 'adivinanza'), 429);
  assert.equal(await llamar(db, CODE), 429, 'bloqueada la red, tampoco entra el grupo');
  assert.equal(await llamar(db, CODE, '2.2.2.2'), 200, 'otra red no se afecta');
}));

test('un acierto con un código de espacio no cuenta como fallo: muchos aciertos seguidos no bloquean', () => conPasscode(async () => {
  const db = await base();
  for (let i = 0; i < 30; i += 1) assert.equal(await llamar(db, CODE), 200);
  for (let i = 0; i < 10; i += 1) assert.equal(await llamar(db, 'mal'), 401);
  assert.equal(await llamar(db, 'mal'), 429);
}));

test('un acierto de la administración (ADMIN_PASSCODE) sí reinicia el contador de la red', () => conPasscode(async () => {
  const db = await base();
  for (let i = 0; i < 9; i += 1) assert.equal(await llamar(db, 'mal'), 401);
  assert.equal(await llamar(db, ADMIN), 200);
  for (let i = 0; i < 10; i += 1) assert.equal(await llamar(db, 'mal'), 401, `fallo ${i + 1} tras el acierto`);
  assert.equal(await llamar(db, 'mal'), 429);
}));
