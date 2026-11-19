import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFileDb, openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { generateCode, hashCode } from '../src/spaces.mjs';

test('migración: una base nueva tiene el espacio administrador y su viaje inicial le pertenece', async () => {
  const db = await openMemoryDb();
  const spaces = await db.all('SELECT id, name, code_hash, is_admin, active FROM spaces');
  assert.deepEqual(spaces, [{ id: 'space-admin', name: 'Principal', code_hash: null, is_admin: 1, active: 1 }]);
  const trips = await db.all('SELECT id, space_id FROM trips');
  assert.deepEqual(trips, [{ id: 'trip-1', space_id: 'space-admin' }]);
});

// Base de antes de los espacios: las tres tablas sin space_id y una fila en cada una.
function crearBaseAnterior() {
  const dir = mkdtempSync(join(tmpdir(), 'bg-spaces-'));
  const file = join(dir, 'anterior.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE trips (id TEXT PRIMARY KEY, name TEXT NOT NULL, dest_currency TEXT NOT NULL, home_currency TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE payment_methods (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, last4 TEXT, card_type TEXT, owner_person_id TEXT NOT NULL);
    INSERT INTO people VALUES ('yo', 'Yo');
    INSERT INTO trips VALUES ('t1', 'Lisboa', 'EUR', 'COP', '2026-01-01T00:00:00Z');
    INSERT INTO payment_methods VALUES ('m', 'cash', 'Efectivo', NULL, NULL, 'yo');
  `);
  old.close();
  return { dir, file };
}

// El adaptador no cierra el archivo y en Windows no se puede borrar abierto: la limpieza es de mejor esfuerzo.
function limpiar(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // el sistema borrará el temporal más adelante
  }
}

async function filasConEspacio(db) {
  return {
    people: await db.all('SELECT id, space_id FROM people'),
    trips: await db.all('SELECT id, space_id FROM trips ORDER BY id'),
    methods: await db.all('SELECT id, space_id FROM payment_methods'),
  };
}

test('migración: una base anterior sin espacios conserva todo y lo asigna al administrador', async () => {
  const { dir, file } = crearBaseAnterior();
  try {
    const rows = await filasConEspacio(await openFileDb(file));
    assert.deepEqual(rows.people, [{ id: 'yo', space_id: 'space-admin' }]);
    assert.deepEqual(rows.trips, [{ id: 't1', space_id: 'space-admin' }]);
    assert.deepEqual(rows.methods, [{ id: 'm', space_id: 'space-admin' }]);
  } finally {
    limpiar(dir);
  }
});

test('migración: es idempotente', async () => {
  const { dir, file } = crearBaseAnterior();
  try {
    const first = await filasConEspacio(await openFileDb(file));
    const db = await openFileDb(file);
    assert.deepEqual(await filasConEspacio(db), first);
    assert.equal((await db.all('SELECT id FROM spaces WHERE is_admin = 1')).length, 1);
    assert.equal((await db.all('SELECT id FROM spaces')).length, 1);
  } finally {
    limpiar(dir);
  }
});

// ---------- códigos y acceso ----------

const CODIGO_DE_PRUEBA = 'K7M4-X9QD-H2RT';

async function crearEspacio(db, { id = 'space-prueba', name = 'Familia', code = CODIGO_DE_PRUEBA, active = 1 } = {}) {
  await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, ?, ?)', [
    id, name, hashCode(code), active, new Date().toISOString(),
  ]);
}

const ping = (db, passcode, ip = '1.1.1.1') => handle({ method: 'GET', path: '/api/ping', passcode, ip, db });

// Ejecuta `fn` con APP_PASSCODE definido (o sin él si `valor` es undefined) y lo deja como estaba.
async function conPasscode(valor, fn) {
  if (valor === undefined) delete process.env.APP_PASSCODE;
  else process.env.APP_PASSCODE = valor;
  try {
    return await fn();
  } finally {
    delete process.env.APP_PASSCODE;
  }
}

test('generateCode: 12 caracteres del alfabeto sin ambiguos, en grupos de 4', () => {
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){2}$/);
    codes.add(code);
  }
  assert.equal(codes.size, 200);
});

test('normalizeCode y hashCode: minúsculas, sin guiones, espacios ni salto de línea dan el mismo hash', () => {
  assert.equal(hashCode(' k7m4-x9qd h2rt\n'), hashCode('K7M4X9QDH2RT'));
});

test('el código del administrador (APP_PASSCODE) entra al espacio administrador', async () => {
  const db = await openMemoryDb();
  await conPasscode('secreto', async () => {
    const r = await ping(db, 'secreto');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, space: { id: 'space-admin', name: 'Principal', is_admin: true } });
  });
});

test('un código de espacio activo entra a su espacio, escrito de cualquier forma', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db);
  await conPasscode('secreto', async () => {
    const r = await ping(db, ' k7m4x9qd-h2rt\n');
    assert.equal(r.status, 200);
    assert.equal(r.body.space.id, 'space-prueba');
    assert.equal(r.body.space.is_admin, false);
  });
});

test('espacio desactivado y código inexistente dan la misma respuesta', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db, { active: 0 });
  await conPasscode('secreto', async () => {
    const apagado = await ping(db, CODIGO_DE_PRUEBA, '1.1.1.1');
    const inexistente = await ping(db, 'AAAA-BBBB-CCCC', '2.2.2.2');
    assert.equal(apagado.status, 401);
    assert.equal(apagado.body.error, 'Código incorrecto');
    assert.deepEqual(inexistente, apagado);
  });
});

test('el límite de intentos sigue valiendo con espacios', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db);
  await conPasscode('secreto', async () => {
    for (let i = 0; i < 10; i += 1) assert.equal((await ping(db, 'mal')).status, 401);
    assert.equal((await ping(db, 'mal')).status, 429);
    assert.equal((await ping(db, CODIGO_DE_PRUEBA)).status, 429); // bloqueado aunque acierte
    const otra = await ping(db, CODIGO_DE_PRUEBA, '2.2.2.2');
    assert.equal(otra.status, 200);
    assert.equal(otra.body.space.id, 'space-prueba');
  });
});

test('sin APP_PASSCODE y sin código: espacio administrador', async () => {
  const db = await openMemoryDb();
  await conPasscode(undefined, async () => {
    assert.equal((await ping(db, undefined)).body.space.id, 'space-admin');
    assert.equal((await ping(db, 'cualquier cosa')).body.space.id, 'space-admin');
  });
});

test('sin APP_PASSCODE, un código de espacio activo entra a ese espacio', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db);
  await conPasscode(undefined, async () => {
    assert.equal((await ping(db, CODIGO_DE_PRUEBA)).body.space.id, 'space-prueba');
  });
});

test('cambiar APP_PASSCODE conserva el espacio administrador', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db);
  const post = (passcode, body) => handle({ method: 'POST', path: '/api/people', body, passcode, ip: '1.1.1.1', db });
  await conPasscode('uno', async () => {
    assert.equal((await post('uno', { id: 'p1', name: 'Ana' })).status, 201);
    assert.equal((await post(CODIGO_DE_PRUEBA, { id: 'p-otro', name: 'Beto' })).status, 201); // en otro espacio
  });
  await conPasscode('dos', async () => {
    assert.equal((await ping(db, 'dos')).body.space.id, 'space-admin');
    const state = await handle({ method: 'GET', path: '/api/state', passcode: 'dos', ip: '1.1.1.1', db });
    assert.equal(state.body.space.id, 'space-admin');
    assert.deepEqual(state.body.people.map((p) => p.id), ['p1']); // la suya sí, la del otro espacio no
    assert.equal((await ping(db, 'uno', '2.2.2.2')).status, 401); // el código anterior ya no entra
  });
});
