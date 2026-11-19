import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFileDb, openMemoryDb } from '../src/db.mjs';

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
