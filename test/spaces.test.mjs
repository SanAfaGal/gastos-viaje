import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFileDb, openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { generateCode, hashCode } from '../src/spaces.mjs';
import { DEFAULT_SETTINGS } from '../public/js/currencies.mjs';

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

test('un código que se reduce a vacío nunca se busca, aunque exista una fila con el hash de lo vacío', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db, { id: 'space-vacio', code: '' }); // code_hash = hashCode('') a propósito
  await conPasscode('secreto', async () => {
    const vacio = await ping(db, '---', '1.1.1.1');
    const inexistente = await ping(db, 'AAAA-BBBB-CCCC', '2.2.2.2');
    assert.equal(vacio.status, 401);
    assert.deepEqual(vacio, inexistente);
    assert.equal((await ping(db, '\n', '3.3.3.3')).status, 401);
  });
});

// ---------- administración de espacios ----------

const ADMIN = 'secreto';
const FORMATO_CODIGO = /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){2}$/;

const llamar = (db, passcode, method, path, body, ip = '9.9.9.9') => handle({ method, path, body, passcode, ip, db });
const admin = (db, method, path, body) => llamar(db, ADMIN, method, path, body);
const estado = (db, passcode) => llamar(db, passcode, 'GET', '/api/state');

test('solo el administrador usa /api/spaces: los demás reciben 404', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db);
  await conPasscode(ADMIN, async () => {
    const rutas = [
      ['GET', '/api/spaces', undefined],
      ['POST', '/api/spaces', { name: 'Intruso' }],
      ['POST', '/api/spaces/space-prueba/regenerate', undefined],
      ['PUT', '/api/spaces/space-prueba', { active: false }],
    ];
    for (const [method, path, body] of rutas) {
      const r = await llamar(db, CODIGO_DE_PRUEBA, method, path, body);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.deepEqual(r.body, { error: 'Ruta no encontrada' });
    }
    // Ni siquiera con un cuerpo inválido: la ruta no se revela y nada cambió.
    assert.equal((await llamar(db, CODIGO_DE_PRUEBA, 'POST', '/api/spaces', {})).status, 404);
    assert.equal((await llamar(db, CODIGO_DE_PRUEBA, 'PUT', '/api/spaces/space-prueba', { active: 'x' })).status, 404);
    assert.equal((await db.all('SELECT id FROM spaces')).length, 2);
    assert.equal((await db.all('SELECT active FROM spaces WHERE id = ?', ['space-prueba']))[0].active, 1);
  });
});

test('crear: devuelve el código una sola vez y el espacio entra con él', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const r = await admin(db, 'POST', '/api/spaces', { name: '  Familia Pérez ' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.body).sort(), ['code', 'id', 'name']);
    assert.equal(r.body.name, 'Familia Pérez');
    assert.match(r.body.code, FORMATO_CODIGO);

    const entra = await llamar(db, r.body.code.toLowerCase(), 'GET', '/api/ping');
    assert.equal(entra.status, 200);
    assert.equal(entra.body.space.id, r.body.id);
    assert.equal(entra.body.space.is_admin, false);

    const suyo = await estado(db, r.body.code);
    assert.equal(suyo.body.trips.length, 1);
    assert.equal(suyo.body.trips[0].name, 'Viaje 1');
    assert.equal(suyo.body.trips[0].dest, DEFAULT_SETTINGS.dest);
    assert.equal(suyo.body.trips[0].home, DEFAULT_SETTINGS.home);

    const delAdmin = await estado(db, ADMIN);
    assert.deepEqual(delAdmin.body.trips.map((t) => t.id), ['trip-1']); // el administrador no ve el viaje nuevo

    // Solo se guarda el hash, nunca el código.
    const fila = (await db.all('SELECT code_hash FROM spaces WHERE id = ?', [r.body.id]))[0];
    assert.equal(fila.code_hash, hashCode(r.body.code));
  });
});

test('listar: nunca incluye código ni hash, ni datos de los espacios', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db, { id: 'space-b', name: 'B' });
  await conPasscode(ADMIN, async () => {
    const creado = await admin(db, 'POST', '/api/spaces', { name: 'Nuevo' });
    await llamar(db, creado.body.code, 'POST', '/api/people', { id: 'p-secreta', name: 'Persona Secreta' });
    const r = await admin(db, 'GET', '/api/spaces');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.equal(r.body.length, 3);
    const texto = JSON.stringify(r.body);
    assert.ok(!texto.includes('code'));
    assert.ok(!texto.includes('hash'));
    assert.ok(!texto.includes(creado.body.code));
    assert.ok(!texto.includes('Persona Secreta'));
    for (const e of r.body) {
      assert.deepEqual(Object.keys(e), ['id', 'name', 'created_at', 'active', 'is_admin']);
      assert.equal(typeof e.active, 'boolean');
      assert.equal(typeof e.is_admin, 'boolean');
    }
    assert.equal(r.body[0].id, 'space-admin'); // el administrador primero
    assert.equal(r.body[0].is_admin, true);
    assert.deepEqual(r.body.slice(1).map((e) => e.id), ['space-b', creado.body.id]); // luego por creación
  });
});

test('regenerar: el código anterior falla y el nuevo entra', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const creado = await admin(db, 'POST', '/api/spaces', { name: 'Familia' });
    await llamar(db, creado.body.code, 'POST', '/api/people', { id: 'p1', name: 'Ana' });
    const r = await admin(db, 'POST', `/api/spaces/${creado.body.id}/regenerate`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['code', 'id']);
    assert.equal(r.body.id, creado.body.id);
    assert.match(r.body.code, FORMATO_CODIGO);
    assert.notEqual(r.body.code, creado.body.code);
    assert.equal((await llamar(db, creado.body.code, 'GET', '/api/ping', undefined, '2.2.2.2')).status, 401);
    const nuevo = await estado(db, r.body.code);
    assert.equal(nuevo.status, 200);
    assert.deepEqual(nuevo.body.people.map((p) => p.id), ['p1']); // los datos siguen
  });
});

test('desactivar: el espacio no entra, sus datos siguen; al reactivar vuelve todo', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const creado = await admin(db, 'POST', '/api/spaces', { name: 'Familia' });
    const { code, id } = creado.body;
    assert.equal((await llamar(db, code, 'POST', '/api/people', { id: 'p1', name: 'Ana' })).status, 201);

    const off = await admin(db, 'PUT', `/api/spaces/${id}`, { active: false });
    assert.deepEqual(off, { status: 200, body: { id, active: false } });
    assert.equal((await llamar(db, code, 'GET', '/api/ping', undefined, '2.2.2.2')).status, 401);
    assert.equal((await db.all('SELECT id FROM people WHERE id = ?', ['p1'])).length, 1); // los datos siguen
    const lista = await admin(db, 'GET', '/api/spaces');
    assert.equal(lista.body.find((e) => e.id === id).active, false);

    const on = await admin(db, 'PUT', `/api/spaces/${id}`, { active: true });
    assert.deepEqual(on, { status: 200, body: { id, active: true } });
    const vuelve = await estado(db, code);
    assert.equal(vuelve.status, 200);
    assert.deepEqual(vuelve.body.people.map((p) => p.id), ['p1']);
  });
});

test('el espacio administrador no se puede regenerar ni desactivar', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const regenerar = await admin(db, 'POST', '/api/spaces/space-admin/regenerate');
    assert.deepEqual(regenerar, { status: 400, body: { error: 'El espacio administrador no se puede cambiar' } });
    const apagar = await admin(db, 'PUT', '/api/spaces/space-admin', { active: false });
    assert.deepEqual(apagar, { status: 400, body: { error: 'El espacio administrador no se puede cambiar' } });
    assert.equal((await ping(db, ADMIN)).status, 200);
    assert.deepEqual(await db.all('SELECT code_hash, active FROM spaces WHERE id = ?', ['space-admin']), [{ code_hash: null, active: 1 }]);
  });
});

test('un id inexistente da 404 No encontrado', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const a = await admin(db, 'POST', '/api/spaces/nada/regenerate');
    assert.deepEqual(a, { status: 404, body: { error: 'No encontrado' } });
    const b = await admin(db, 'PUT', '/api/spaces/nada', { active: true });
    assert.deepEqual(b, { status: 404, body: { error: 'No encontrado' } });
  });
});

test('activar o desactivar pide un booleano de verdad', async () => {
  const db = await openMemoryDb();
  await crearEspacio(db);
  await conPasscode(ADMIN, async () => {
    for (const active of ['false', 0, 1, null, undefined, 'true']) {
      const r = await admin(db, 'PUT', '/api/spaces/space-prueba', active === undefined ? {} : { active });
      assert.equal(r.status, 400, String(active));
    }
    assert.equal((await admin(db, 'PUT', '/api/spaces/space-prueba')).status, 400); // sin cuerpo
    assert.equal((await db.all('SELECT active FROM spaces WHERE id = ?', ['space-prueba']))[0].active, 1);
  });
});

test('nombre vacío o de más de 40 caracteres: 400', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(41) }, undefined]) {
      assert.equal((await admin(db, 'POST', '/api/spaces', body)).status, 400);
    }
    assert.equal((await admin(db, 'POST', '/api/spaces', { name: 'x'.repeat(40) })).status, 201);
    assert.equal((await db.all('SELECT id FROM spaces')).length, 2); // los rechazados no dejaron nada
  });
});

test('dos espacios creados tienen códigos distintos y ninguno entra al otro', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const a = (await admin(db, 'POST', '/api/spaces', { name: 'A' })).body;
    const b = (await admin(db, 'POST', '/api/spaces', { name: 'B' })).body;
    assert.notEqual(a.code, b.code);
    assert.notEqual(a.id, b.id);
    assert.equal((await llamar(db, a.code, 'GET', '/api/ping')).body.space.id, a.id);
    assert.equal((await llamar(db, b.code, 'GET', '/api/ping')).body.space.id, b.id);
    await llamar(db, a.code, 'POST', '/api/people', { id: 'pa', name: 'De A' });
    assert.deepEqual((await estado(db, b.code)).body.people, []);
  });
});

// Base que rechaza las primeras `n` escrituras como si el código ya existiera (índice único de code_hash).
function conColisiones(db, n) {
  let pendientes = n;
  const colision = () => {
    if (pendientes <= 0) return false;
    pendientes -= 1;
    return true;
  };
  return {
    all: (sql, args) => db.all(sql, args),
    run: async (sql, args) => {
      if (/UPDATE spaces SET code_hash/.test(sql) && colision()) throw new Error('UNIQUE constraint failed: spaces.code_hash');
      return db.run(sql, args);
    },
    batch: async (stmts) => {
      if (colision()) throw new Error('UNIQUE constraint failed: spaces.code_hash');
      return db.batch(stmts);
    },
  };
}

test('crear y regenerar reintentan si el código choca con otro, y no dejan un 500', async () => {
  const db = await openMemoryDb();
  await conPasscode(ADMIN, async () => {
    const creado = await admin(conColisiones(db, 2), 'POST', '/api/spaces', { name: 'Familia' });
    assert.equal(creado.status, 201);
    assert.equal((await db.all('SELECT id FROM spaces')).length, 2);
    assert.equal((await db.all('SELECT id FROM trips WHERE space_id = ?', [creado.body.id])).length, 1);

    const nuevo = await admin(conColisiones(db, 2), 'POST', `/api/spaces/${creado.body.id}/regenerate`);
    assert.equal(nuevo.status, 200);
    assert.equal((await llamar(db, nuevo.body.code, 'GET', '/api/ping')).body.space.id, creado.body.id);
  });
});

test('un error de base que no es colisión no se reintenta: 500 sin detalles', async () => {
  const db = await openMemoryDb();
  let intentos = 0;
  const rota = {
    all: (sql, args) => db.all(sql, args),
    run: (sql, args) => db.run(sql, args),
    batch: async () => {
      intentos += 1;
      throw new Error('disco lleno');
    },
  };
  const consola = console.error;
  console.error = () => {};
  try {
    await conPasscode(ADMIN, async () => {
      const r = await admin(rota, 'POST', '/api/spaces', { name: 'Familia' });
      assert.deepEqual(r, { status: 500, body: { error: 'Error interno' } });
      assert.equal(intentos, 1);
    });
  } finally {
    console.error = consola;
  }
});
