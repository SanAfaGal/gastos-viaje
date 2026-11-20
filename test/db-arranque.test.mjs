// Arranque de la base: dos instancias que migran a la vez y una apertura que falla no dejan la app caída.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getDb, openFileDb } from '../src/db.mjs';
import api from '../netlify/functions/api.mjs';

delete process.env.APP_PASSCODE;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));

// El adaptador no cierra el archivo y en Windows no se puede borrar abierto: la limpieza es de mejor esfuerzo.
function limpiar(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // el sistema borrará el temporal más adelante
  }
}

// Base de antes de los espacios y de los medios con color: varias columnas por agregar al arrancar.
function crearBaseAnterior(dir) {
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
  return file;
}

// Una ruta que no se puede crear: su carpeta "padre" es un archivo.
function rutaImposible(dir) {
  const archivo = join(dir, 'soy-un-archivo');
  writeFileSync(archivo, 'x');
  return join(archivo, 'sub', 'gastos.db');
}

test('dos instancias que arrancan a la vez sobre una base anterior: ambas abren y los datos quedan intactos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-arranque-'));
  try {
    const file = crearBaseAnterior(dir);
    const res = await Promise.allSettled([openFileDb(file), openFileDb(file)]);
    assert.deepEqual(res.map((r) => r.status), ['fulfilled', 'fulfilled'], res.map((r) => r.reason?.message).join(' | '));
    const db = res[0].value;
    assert.deepEqual(await db.all('SELECT id, space_id FROM people'), [{ id: 'yo', space_id: 'space-admin' }]);
    assert.deepEqual(await db.all('SELECT id, space_id FROM trips'), [{ id: 't1', space_id: 'space-admin' }]);
    assert.deepEqual(await db.all('SELECT id, space_id, color, network FROM payment_methods'), [{ id: 'm', space_id: 'space-admin', color: null, network: null }]);
    assert.equal((await db.all('SELECT id FROM spaces')).length, 1);
  } finally {
    limpiar(dir);
  }
});

test('si abrir la base falla, la función de Netlify responde 500 en JSON y la siguiente petición vuelve a intentar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-arranque-'));
  try {
    process.env.DB_FILE = rutaImposible(dir);
    const res = await api(new Request('http://localhost/api/ping'), {});
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /json/);
    assert.deepEqual(await res.json(), { error: 'Error interno' });
    await assert.rejects(getDb());

    process.env.DB_FILE = join(dir, 'buena.db');
    const db = await getDb(); // la falla anterior no quedó guardada
    assert.equal((await db.all('SELECT id FROM spaces')).length, 1);
    const ok = await api(new Request('http://localhost/api/ping'), {});
    assert.equal(ok.status, 200);
  } finally {
    delete process.env.DB_FILE;
    limpiar(dir);
  }
});

const puertoLibre = () => new Promise((ok, mal) => {
  const s = createServer();
  s.once('error', mal);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});

test('si abrir la base falla, el servidor local responde 500 en JSON a la API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-arranque-'));
  const port = await puertoLibre();
  const env = { ...process.env, DB_FILE: rutaImposible(dir), PORT: String(port), HOST: '127.0.0.1' };
  delete env.APP_PASSCODE;
  delete env.TURSO_DATABASE_URL;
  const hijo = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(raiz, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((ok, mal) => {
      const t = setTimeout(() => mal(new Error('el servidor no arrancó')), 10000);
      hijo.stdout.on('data', (d) => { if (String(d).includes('Gastos de viaje en')) { clearTimeout(t); ok(); } });
      hijo.once('exit', (c) => { clearTimeout(t); mal(new Error(`el servidor terminó (${c})`)); });
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /json/);
    assert.deepEqual(await res.json(), { error: 'Error interno' });
  } finally {
    hijo.kill();
    limpiar(dir);
  }
});
