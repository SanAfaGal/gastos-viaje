// Administración separada de los datos: ADMIN_PASSCODE solo gestiona espacios y Principal es un espacio más,
// cuyo código se siembra una sola vez con APP_PASSCODE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.mjs';
import { handle } from '../src/handlers.mjs';
import { hashCode } from '../src/spaces.mjs';

delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const ADMIN = 'clave-larga-de-la-administracion';
const APP = 'clave-de-siempre-del-dueño';
const CODE_B = 'BBBB-CCCC-DDDD';
const DIA = '2026-11-14';
const NO_RUTA = { status: 404, body: { error: 'Ruta no encontrada' } };
const DESACTIVADO = { status: 403, body: { error: 'Este espacio está desactivado. Habla con quien te dio el código.' } };

// Base del celular para la última prueba (store.js): un almacenamiento en memoria y un fetch que llama al servidor.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
let dbDelCelular = null;
let enLinea = true;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://x');
  // Nada de este archivo debe salir a internet (tasas, enlaces de mapas): solo las rutas del propio servidor.
  if (!enLinea || !dbDelCelular || !u.pathname.startsWith('/api/')) throw new TypeError('sin conexión');
  const out = await handle({
    method: opts.method ?? 'GET',
    path: u.pathname,
    query: u.searchParams,
    body: opts.body ? JSON.parse(opts.body) : null,
    passcode: opts.headers?.['x-passcode'],
    db: dbDelCelular,
  });
  return { ok: out.status < 400, status: out.status, headers: new Map(), json: async () => out.body };
};

// Ejecuta `fn` con ADMIN_PASSCODE y APP_PASSCODE como se indique (undefined = ausente) y los deja como estaban.
async function conEntorno({ admin, app }, fn) {
  const antes = { ADMIN_PASSCODE: process.env.ADMIN_PASSCODE, APP_PASSCODE: process.env.APP_PASSCODE };
  const poner = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  poner('ADMIN_PASSCODE', admin);
  poner('APP_PASSCODE', app);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) poner(k, v);
  }
}

async function crearEspacio(db, id, name, code, active = 1) {
  await db.run('INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, ?, 0, ?, ?)', [
    id, name, hashCode(code), active, new Date().toISOString(),
  ]);
}

// Datos en Principal (viaje trip-1) y en el espacio B: persona, medio de pago, gasto con su persona y abono.
async function conDatos() {
  const db = await openMemoryDb();
  await crearEspacio(db, 'space-b', 'Grupo B', CODE_B);
  await db.run("INSERT INTO trips (id, name, dest_currency, home_currency, created_at, space_id) VALUES ('tb', 'Viaje B', 'BRL', 'COP', ?, 'space-b')", [new Date().toISOString()]);
  for (const [s, trip, sp] of [['a', 'trip-1', 'space-admin'], ['b', 'tb', 'space-b']]) {
    await db.run('INSERT INTO people (id, name, space_id) VALUES (?, ?, ?)', [`p${s}`, `Persona ${s}`, sp]);
    await db.run('INSERT INTO people (id, name, space_id) VALUES (?, ?, ?)', [`q${s}`, `Otra ${s}`, sp]);
    await db.run('INSERT INTO trip_people (trip_id, person_id) VALUES (?, ?), (?, ?)', [trip, `p${s}`, trip, `q${s}`]);
    await db.run("INSERT INTO payment_methods (id, kind, name, owner_person_id, space_id) VALUES (?, 'cash', 'Efectivo', ?, ?)", [`m${s}`, `p${s}`, sp]);
    await db.run(
      `INSERT INTO expenses (id, date, amount_cents, description, payment_method_id, created_at, trip_id)
       VALUES (?, ?, 1000, 'Taxi', ?, ?, ?)`,
      [`e${s}`, DIA, `m${s}`, `${DIA}T00:00:00Z`, trip],
    );
    await db.run('INSERT INTO expense_beneficiaries (expense_id, person_id) VALUES (?, ?)', [`e${s}`, `p${s}`]);
    await db.run(
      `INSERT INTO payments (id, trip_id, from_person_id, to_person_id, date, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, 500, ?)`,
      [`y${s}`, trip, `p${s}`, `q${s}`, DIA, `${DIA}T00:00:00Z`],
    );
  }
  await db.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', DIA, 700]);
  return db;
}

// Base que anota cada sentencia: sirve para ver que la administración no consulta ninguna tabla de datos.
function espiar(db) {
  const sql = [];
  return {
    sql,
    db: {
      all: (s, a) => (sql.push(s), db.all(s, a)),
      run: (s, a) => (sql.push(s), db.run(s, a)),
      batch: (stmts) => (sql.push(...stmts.map((x) => x.sql)), db.batch(stmts)),
    },
  };
}
const TABLAS_DE_DATOS = /\b(spaces|trips|trip_people|people|payment_methods|expenses|expense_beneficiaries|payments|rates)\b/i;

async function fotoDeTablas(db) {
  const tablas = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'auth_failures' ORDER BY name")).map((t) => t.name);
  const foto = {};
  for (const t of tablas) foto[t] = await db.all(`SELECT * FROM ${t} ORDER BY rowid`);
  return foto;
}

const llamar = (db, passcode, method, path, body, query = {}, ip = '1.1.1.1') =>
  handle({ method, path, body, query: new URLSearchParams(query), passcode, ip, db });
const ping = (db, passcode, ip = '1.1.1.1') => llamar(db, passcode, 'GET', '/api/ping', undefined, {}, ip);
const estado = (db, passcode, ip) => llamar(db, passcode, 'GET', '/api/state', undefined, {}, ip);
const codigoDePrincipal = async (db) => (await db.all("SELECT code_hash FROM spaces WHERE id = 'space-admin'"))[0].code_hash;

const RUTAS_DE_ESPACIOS = [
  ['GET', '/api/spaces', undefined],
  ['POST', '/api/spaces', { name: 'Intruso' }],
  ['POST', '/api/spaces/space-b/regenerate', undefined],
  ['PUT', '/api/spaces/space-b', { active: false }],
];

test('ADMIN_PASSCODE entra como administración: estado vacío, sin consultar datos', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const base = await conDatos();
  const { db, sql } = espiar(base);
  const r = await estado(db, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.space.is_manager, true);
  assert.equal(r.body.space.id, 'manager');
  assert.deepEqual(r.body.space, { id: 'manager', name: 'Administración', is_principal: false, is_manager: true });
  for (const k of ['trips', 'people', 'payment_methods', 'expenses', 'payments']) assert.deepEqual(r.body[k], [], k);
  assert.equal(typeof r.body.today, 'string');
  assert.deepEqual(Object.keys(r.body).sort(), ['expenses', 'payment_methods', 'payments', 'people', 'space', 'today', 'trips']);
  const p = await ping(db, ADMIN);
  assert.deepEqual(p.body, { ok: true, space: { id: 'manager', name: 'Administración', is_principal: false, is_manager: true } });
  assert.deepEqual(sql.filter((s) => TABLAS_DE_DATOS.test(s)), [], 'solo se toca el contador de intentos');
  // Principal sí tiene datos: los ve quien entra con su código, no la administración.
  const principal = await estado(base, APP);
  assert.deepEqual(principal.body.people.map((x) => x.id).sort(), ['pa', 'qa']);
}));

test('la administración recibe 404 en cada ruta de datos y no cambia nada', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const base = await conDatos();
  const respaldo = (await llamar(base, CODE_B, 'GET', '/api/backup')).body;
  assert.ok(respaldo.people?.length, 'el respaldo del grupo B trae datos para intentar restaurarlos');
  const gasto = { date: DIA, amount_cents: 999, description: 'x', payment_method_id: 'ma', beneficiary_ids: ['pa'], trip_id: 'trip-1' };
  const abono = { date: DIA, amount_cents: 9, from_person_id: 'pb', to_person_id: 'qb', trip_id: 'tb' };
  const rutas = [];
  for (const [s, trip] of [['a', 'trip-1'], ['b', 'tb']]) {
    rutas.push(
      ['GET', '/api/trips'],
      ['POST', '/api/trips', { id: `t-nuevo-${s}`, name: 'X', dest: 'EUR', home: 'COP' }],
      ['PUT', `/api/trips/${trip}`, { name: 'Cambiado', dest: 'BRL', home: 'COP', people_ids: [] }],
      ['DELETE', `/api/trips/${trip}`, undefined, { con_gastos: '1' }],
      ['POST', '/api/people', { id: `p-nueva-${s}`, name: 'Nueva', trip_id: trip }],
      ['PUT', `/api/people/p${s}`, { name: 'Cambiada' }],
      ['DELETE', `/api/people/q${s}`],
      ['POST', '/api/payment-methods', { id: `m-nuevo-${s}`, kind: 'cash', name: 'X', owner_person_id: `p${s}` }],
      ['PUT', `/api/payment-methods/m${s}`, { kind: 'cash', name: 'Cambiado', owner_person_id: `p${s}` }],
      ['DELETE', `/api/payment-methods/m${s}`],
      ['POST', '/api/expenses', { ...gasto, id: `e-nuevo-${s}` }],
      ['PUT', `/api/expenses/e${s}`, { ...gasto, payment_method_id: `m${s}`, beneficiary_ids: [`p${s}`] }],
      ['DELETE', `/api/expenses/e${s}`],
      ['POST', '/api/payments', { ...abono, id: `y-nuevo-${s}` }],
      ['PUT', `/api/payments/y${s}`, { ...abono, from_person_id: `p${s}`, to_person_id: `q${s}`, trip_id: trip }],
      ['DELETE', `/api/payments/y${s}`],
      ['POST', '/api/order', { ids: [`e${s}`] }],
      ['GET', '/api/rates/history', undefined, { trip, days: '30' }],
      ['POST', '/api/rates/refresh', undefined, { trip }],
      ['POST', '/api/rates/refresh', undefined, { trip, dry: '1' }],
      ['GET', '/api/rate', undefined, { trip, date: DIA }],
    );
  }
  rutas.push(
    ['GET', '/api/rate'],
    ['GET', '/api/backup'],
    ['POST', '/api/restore', respaldo],
    ['POST', '/api/restore', respaldo, { dry: '1' }],
    ['GET', '/api/resolve-place', undefined, { url: 'https://maps.app.goo.gl/abc' }],
    ['POST', '/api/ping'],
    ['PUT', '/api/state'],
  );
  const antes = await fotoDeTablas(base);
  const { db, sql } = espiar(base);
  for (const [method, path, body, query] of rutas) {
    const r = await llamar(db, ADMIN, method, path, body, query);
    assert.deepEqual(r, NO_RUTA, `${method} ${path} ${JSON.stringify(query ?? {})}`);
    assert.ok(!JSON.stringify(r).match(/Persona|Taxi|Efectivo/), `${method} ${path} no lleva datos`);
  }
  assert.deepEqual(sql.filter((s) => TABLAS_DE_DATOS.test(s)), [], 'ninguna ruta llegó a la base');
  assert.deepEqual(await fotoDeTablas(base), antes);
  // Control positivo: con el código del grupo B la misma restauración sí se procesa (no es un 404 por la ruta).
  assert.equal((await llamar(base, CODE_B, 'POST', '/api/restore', respaldo, { dry: '1' })).status, 200);
}));

test('un código de espacio recibe 404 en /api/spaces; sin ADMIN_PASSCODE también con cualquier código', async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  await conEntorno({ admin: ADMIN, app: APP }, async () => {
    for (const codigo of [CODE_B, APP]) { // APP siembra Principal: también es un espacio de datos
      for (const [method, path, body] of [...RUTAS_DE_ESPACIOS, ['POST', '/api/spaces', {}]]) {
        assert.deepEqual(await llamar(db, codigo, method, path, body), NO_RUTA, `${codigo} ${method} ${path}`);
      }
    }
    assert.equal((await llamar(db, ADMIN, 'GET', '/api/spaces')).status, 200); // control positivo
  });
  await conEntorno({ admin: undefined, app: APP }, async () => {
    for (const codigo of [CODE_B, APP]) {
      for (const [method, path, body] of RUTAS_DE_ESPACIOS) assert.deepEqual(await llamar(db, codigo, method, path, body), NO_RUTA);
    }
    // El valor que tendría ADMIN_PASSCODE no es nada si la variable no está definida.
    assert.equal((await llamar(db, ADMIN, 'GET', '/api/spaces', undefined, {}, '2.2.2.2')).status, 401);
  });
  for (const admin of [undefined, '']) {
    await conEntorno({ admin, app: undefined }, async () => {
      for (const codigo of [undefined, 'cualquier cosa', ADMIN, CODE_B]) {
        for (const [method, path, body] of RUTAS_DE_ESPACIOS) assert.deepEqual(await llamar(db, codigo, method, path, body), NO_RUTA);
      }
    });
  }
  const despues = await fotoDeTablas(db);
  despues.spaces = despues.spaces.map((s) => (s.id === 'space-admin' ? { ...s, code_hash: null } : s)); // la siembra es lo único
  assert.deepEqual(despues, antes);
});

test('solo APP_PASSCODE definida: la app no queda abierta', () => conEntorno({ admin: undefined, app: APP }, async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  assert.deepEqual(await ping(db, undefined), { status: 401, body: { error: 'Código incorrecto' } });
  assert.equal((await estado(db, undefined)).status, 401);
  assert.equal((await estado(db, '')).status, 401);
  assert.equal((await llamar(db, undefined, 'POST', '/api/people', { id: 'intruso', name: 'Intruso' })).status, 401);
  assert.deepEqual(await ping(db, 'otra-cosa'), { status: 401, body: { error: 'Código incorrecto' } });
  assert.deepEqual(await fotoDeTablas(db), antes);
  // El código del dueño entra a Principal (lo siembra) y ve sus datos.
  const r = await estado(db, APP);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.space, { id: 'space-admin', name: 'Principal', is_principal: true, is_manager: false });
}));

test('solo ADMIN_PASSCODE definida: tampoco queda abierta', () => conEntorno({ admin: ADMIN, app: undefined }, async () => {
  const db = await conDatos();
  assert.equal((await ping(db, undefined)).status, 401);
  assert.equal((await ping(db, 'otra-cosa')).status, 401);
  assert.equal((await ping(db, CODE_B)).body.space.id, 'space-b');
  assert.equal(await codigoDePrincipal(db), null);
}));

test('sin ninguna variable: abierta, todos entran a Principal y no hay administración', async () => {
  const db = await conDatos();
  for (const [admin, app] of [[undefined, undefined], ['', ''], [undefined, ''], ['', undefined]]) {
    await conEntorno({ admin, app }, async () => {
      for (const codigo of [undefined, '', 'cualquier cosa', ADMIN, APP]) {
        const r = await estado(db, codigo);
        assert.equal(r.status, 200, String(codigo));
        assert.deepEqual(r.body.space, { id: 'space-admin', name: 'Principal', is_principal: true, is_manager: false });
        assert.deepEqual(r.body.people.map((p) => p.id).sort(), ['pa', 'qa']);
        assert.deepEqual(await llamar(db, codigo, 'GET', '/api/spaces'), NO_RUTA);
      }
      assert.equal((await ping(db, CODE_B)).body.space.id, 'space-b'); // el código de un espacio sigue entrando a él
    });
  }
  assert.equal(await codigoDePrincipal(db), null, 'sin APP_PASSCODE nunca se siembra');
});

test('ADMIN_PASSCODE igual al código de un espacio: gana el administrador', () => conEntorno({ admin: CODE_B, app: APP }, async () => {
  const base = await conDatos();
  const { db, sql } = espiar(base);
  const r = await estado(db, CODE_B);
  assert.equal(r.status, 200);
  assert.equal(r.body.space.is_manager, true);
  for (const k of ['trips', 'people', 'payment_methods', 'expenses', 'payments']) assert.deepEqual(r.body[k], [], k);
  assert.deepEqual(sql.filter((s) => TABLAS_DE_DATOS.test(s)), []);
  assert.deepEqual(await llamar(db, CODE_B, 'GET', '/api/backup'), NO_RUTA);
}));

// ---------- siembra del código de Principal ----------

test('siembra: la primera entrada con APP_PASSCODE deja a Principal con ese hash y entra', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  assert.equal(await codigoDePrincipal(db), null);
  const r = await ping(db, APP);
  assert.deepEqual(r, { status: 200, body: { ok: true, space: { id: 'space-admin', name: 'Principal', is_principal: true, is_manager: false } } });
  assert.equal(await codigoDePrincipal(db), hashCode(APP));
}));

test('entrar otra vez no cambia nada', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  await ping(db, APP);
  const antes = await fotoDeTablas(db);
  for (let i = 0; i < 3; i += 1) assert.equal((await ping(db, APP)).body.space.id, 'space-admin');
  assert.deepEqual(await fotoDeTablas(db), antes);
}));

test('cambiar APP_PASSCODE después de sembrar no cambia el código de Principal: el nuevo valor ya no entra y el anterior sí', async () => {
  const db = await conDatos();
  await conEntorno({ admin: ADMIN, app: APP }, () => ping(db, APP));
  await conEntorno({ admin: ADMIN, app: 'otra-clave-nueva' }, async () => {
    assert.deepEqual(await ping(db, 'otra-clave-nueva'), { status: 401, body: { error: 'Código incorrecto' } });
    assert.equal(await codigoDePrincipal(db), hashCode(APP));
    const viejo = await estado(db, APP, '2.2.2.2');
    assert.equal(viejo.body.space.id, 'space-admin');
    assert.deepEqual(viejo.body.people.map((p) => p.id).sort(), ['pa', 'qa']);
  });
});

test('un Principal que ya tiene código no se pisa (APP_PASSCODE deja de entrar)', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const suyo = 'PPPP-QQQQ-RRRR';
  await db.run("UPDATE spaces SET code_hash = ? WHERE id = 'space-admin'", [hashCode(suyo)]);
  assert.equal((await ping(db, APP)).status, 401);
  assert.equal(await codigoDePrincipal(db), hashCode(suyo));
  assert.equal((await ping(db, suyo)).body.space.id, 'space-admin');
}));

test("APP_PASSCODE que se reduce a vacío (---) no siembra", () => conEntorno({ admin: ADMIN, app: '---' }, async () => {
  const db = await conDatos();
  await db.run("INSERT INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES ('space-vacio', 'Vacío', ?, 0, 1, ?)", [hashCode(''), new Date().toISOString()]);
  assert.deepEqual(await ping(db, '---'), { status: 401, body: { error: 'Código incorrecto' } });
  assert.equal((await ping(db, undefined)).status, 401, 'la app sigue protegida');
  assert.equal(await codigoDePrincipal(db), null);
}));

test('un código de otro espacio nunca siembra', async () => {
  const db = await conDatos();
  await crearEspacio(db, 'space-off', 'Apagado', 'OOOO-FFFF-OOOO', 0);
  await conEntorno({ admin: ADMIN, app: APP }, async () => {
    assert.equal((await ping(db, CODE_B)).body.space.id, 'space-b');
    assert.deepEqual(await ping(db, 'OOOO-FFFF-OOOO'), DESACTIVADO);
  });
  // Aunque APP_PASSCODE sea el código de otro espacio (activo o desactivado), ese código es de ese espacio.
  await conEntorno({ admin: ADMIN, app: CODE_B }, async () => assert.equal((await ping(db, CODE_B)).body.space.id, 'space-b'));
  await conEntorno({ admin: ADMIN, app: 'OOOO-FFFF-OOOO' }, async () => assert.deepEqual(await ping(db, 'OOOO-FFFF-OOOO'), DESACTIVADO));
  assert.equal(await codigoDePrincipal(db), null);
});

test('con Principal desactivado la primera entrada siembra y da 403', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  await db.run("UPDATE spaces SET active = 0 WHERE id = 'space-admin'");
  assert.deepEqual(await ping(db, APP), DESACTIVADO);
  assert.equal(await codigoDePrincipal(db), hashCode(APP));
  assert.deepEqual(await estado(db, APP), DESACTIVADO);
  // Ese 403 no gasta intentos: un celular que recarga muchas veces no se bloquea.
  for (let i = 0; i < 15; i += 1) assert.equal((await ping(db, APP)).status, 403);
  assert.equal((await ping(db, CODE_B)).status, 200);
}));

test('Principal se puede regenerar, desactivar (403 con motivo) y reactivar como cualquier espacio', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  await ping(db, APP); // siembra
  const admin = (method, path, body) => llamar(db, ADMIN, method, path, body, {}, '9.9.9.9');
  const nuevo = await admin('POST', '/api/spaces/space-admin/regenerate');
  assert.equal(nuevo.status, 200);
  assert.equal(nuevo.body.id, 'space-admin');
  assert.equal(await codigoDePrincipal(db), hashCode(nuevo.body.code));
  assert.equal((await ping(db, APP, '2.2.2.2')).status, 401, 'APP_PASSCODE ya no entra ni vuelve a sembrar');
  assert.equal(await codigoDePrincipal(db), hashCode(nuevo.body.code));
  assert.deepEqual((await estado(db, nuevo.body.code)).body.people.map((p) => p.id).sort(), ['pa', 'qa']);

  assert.deepEqual(await admin('PUT', '/api/spaces/space-admin', { active: false }), { status: 200, body: { id: 'space-admin', active: false } });
  assert.deepEqual(await ping(db, nuevo.body.code), DESACTIVADO);
  assert.equal((await admin('GET', '/api/spaces')).body.find((s) => s.id === 'space-admin').active, false);
  assert.equal((await db.all("SELECT id FROM people WHERE space_id = 'space-admin'")).length, 2, 'los datos siguen');

  assert.deepEqual(await admin('PUT', '/api/spaces/space-admin', { active: true }), { status: 200, body: { id: 'space-admin', active: true } });
  assert.equal((await ping(db, nuevo.body.code)).body.space.id, 'space-admin');
}));

test('límite de intentos: acertar con un código de espacio intercalado entre fallos sigue llegando a 429; acertar con ADMIN_PASSCODE reinicia la red', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const st = async (codigo, ip = '1.1.1.1') => (await ping(db, codigo, ip)).status;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await st('adivinanza'), 401, `fallo ${i + 1}`);
    if (i < 9) assert.equal(await st(i % 2 ? CODE_B : APP), 200, 'los códigos de espacio (Principal incluido) siguen entrando');
  }
  assert.equal(await st('adivinanza'), 429);
  assert.equal(await st(CODE_B), 429);
  assert.equal(await st(ADMIN), 429, 'bloqueada la red, tampoco entra la administración');

  for (let i = 0; i < 9; i += 1) assert.equal(await st('mal', '2.2.2.2'), 401);
  assert.equal(await st(ADMIN, '2.2.2.2'), 200);
  for (let i = 0; i < 10; i += 1) assert.equal(await st('mal', '2.2.2.2'), 401, `fallo ${i + 1} tras el acierto`);
  assert.equal(await st('mal', '2.2.2.2'), 429);
}));

test('las claves: ninguna respuesta lleva is_admin; state.space lleva is_principal e is_manager; la lista de espacios no lleva ninguna de las dos', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const respuestas = [];
  for (const codigo of [ADMIN, APP, CODE_B]) {
    const s = await estado(db, codigo);
    assert.deepEqual(Object.keys(s.body.space), ['id', 'name', 'is_principal', 'is_manager']);
    const p = await ping(db, codigo);
    assert.deepEqual(Object.keys(p.body.space), ['id', 'name', 'is_principal', 'is_manager']);
    respuestas.push(s, p);
  }
  const lista = await llamar(db, ADMIN, 'GET', '/api/spaces');
  assert.deepEqual(lista.body.map((s) => s.id), ['space-admin', 'space-b']);
  for (const s of lista.body) assert.deepEqual(Object.keys(s), ['id', 'name', 'created_at', 'active']);
  const creado = await llamar(db, ADMIN, 'POST', '/api/spaces', { name: 'Nuevo' });
  respuestas.push(lista, creado, await llamar(db, ADMIN, 'POST', `/api/spaces/${creado.body.id}/regenerate`));
  respuestas.push(await llamar(db, ADMIN, 'PUT', `/api/spaces/${creado.body.id}`, { active: false }));
  for (const r of respuestas) assert.ok(!JSON.stringify(r).includes('is_admin'), JSON.stringify(r));
}));

test('espacio desactivado con cola en el celular: el servidor responde 403 y la cola del cliente se conserva', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  dbDelCelular = await openMemoryDb();
  await dbDelCelular.run('INSERT INTO rates (pair, date, rate) VALUES (?, ?, ?)', ['BRL-COP', DIA, 700]);
  mem.clear();
  enLinea = true;
  try {
    const store = await import('../public/js/store.js?caso=manager');
    // El dueño entra con el código de siempre (siembra Principal) y deja un gasto sin enviar.
    store.setPass(APP);
    const info = await store.ping();
    assert.equal(info.space.is_principal, true);
    store.adoptSpace(info.space);
    await store.refresh();
    await store.savePerson({ id: 'yo', name: 'Yo' });
    await store.saveMethod({ id: 'cash', kind: 'cash', name: 'Efectivo', owner_person_id: 'yo' });
    await store.refresh();
    enLinea = false;
    await store.saveExpense({ id: 'x1', date: DIA, amount_cents: 1000, description: 'Taxi', payment_method_id: 'cash', beneficiary_ids: ['yo'] });
    enLinea = true;
    assert.equal(store.pendingCount(), 1);

    // La administración desactiva Principal: el celular recibe el motivo y no pierde su cola.
    const off = await llamar(dbDelCelular, ADMIN, 'PUT', '/api/spaces/space-admin', { active: false }, {}, '9.9.9.9');
    assert.equal(off.status, 200);
    assert.deepEqual(await ping(dbDelCelular, APP), DESACTIVADO);
    const r = await store.flush();
    assert.equal(r.sent, 0);
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.net.needsLogin, true);
    assert.equal(JSON.parse(mem.get('bg_queue')).length, 1);
    assert.equal((await dbDelCelular.all('SELECT id FROM expenses')).length, 0);

    // Al reactivar, el mismo código vuelve a entrar y la cola se envía a Principal.
    await llamar(dbDelCelular, ADMIN, 'PUT', '/api/spaces/space-admin', { active: true }, {}, '9.9.9.9');
    store.setPass(APP);
    const otra = await store.ping();
    assert.equal(store.discardCount(otra.space), 0);
    store.adoptSpace(otra.space);
    await store.flush();
    await store.flush();
    assert.equal(store.pendingCount(), 0);
    assert.deepEqual(await dbDelCelular.all('SELECT e.id, t.space_id FROM expenses e JOIN trips t ON t.id = e.trip_id'), [{ id: 'x1', space_id: 'space-admin' }]);
  } finally {
    dbDelCelular = null;
  }
}));

// ---------- renombrar espacios ----------

const nombreDe = async (db, id) => (await db.all('SELECT name FROM spaces WHERE id = ?', [id]))[0]?.name;

test('renombrar: cambia el nombre, lo recorta y la lista lo muestra', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const r = await llamar(db, ADMIN, 'PUT', '/api/spaces/space-b', { name: '  Familia Pérez  ' });
  assert.deepEqual(r, { status: 200, body: { id: 'space-b', name: 'Familia Pérez' } });
  assert.equal(await nombreDe(db, 'space-b'), 'Familia Pérez');
  const lista = await llamar(db, ADMIN, 'GET', '/api/spaces');
  assert.equal(lista.body.find((s) => s.id === 'space-b').name, 'Familia Pérez');
  assert.equal((await ping(db, CODE_B)).body.space.name, 'Familia Pérez');
  assert.ok(!JSON.stringify(r).match(/hash/i));
  // 40 caracteres justos sí entran.
  assert.equal((await llamar(db, ADMIN, 'PUT', '/api/spaces/space-b', { name: 'x'.repeat(40) })).status, 200);
}));

test('renombrar: Principal se puede renombrar', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const r = await llamar(db, ADMIN, 'PUT', '/api/spaces/space-admin', { name: 'Casa' });
  assert.deepEqual(r, { status: 200, body: { id: 'space-admin', name: 'Casa' } });
  const e = await estado(db, APP);
  assert.deepEqual(e.body.space, { id: 'space-admin', name: 'Casa', is_principal: true, is_manager: false });
}));

test('renombrar: nombre vacío, solo espacios, de 41 caracteres o que no es texto (123, {}, null) dan 400', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  for (const name of ['', '   ', '\n\t', 'x'.repeat(41), `  ${'x'.repeat(41)}  `, 123, 0, true, {}, [], ['Hola'], null]) {
    const r = await llamar(db, ADMIN, 'PUT', '/api/spaces/space-b', { name });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.deepEqual(await fotoDeTablas(db), antes);
}));

test('renombrar: un cuerpo con name y active a la vez, o sin ninguna de las dos, da 400', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  const ERROR = { status: 400, body: { error: 'Indica solo name o active' } };
  for (const body of [{ name: 'Nuevo', active: false }, { name: 'Nuevo', active: true }, { name: null, active: false }, {}, { otro: 1 }, undefined, null]) {
    assert.deepEqual(await llamar(db, ADMIN, 'PUT', '/api/spaces/space-b', body), ERROR, JSON.stringify(body));
  }
  assert.deepEqual(await fotoDeTablas(db), antes);
  // active sigue siendo un booleano de verdad.
  assert.equal((await llamar(db, ADMIN, 'PUT', '/api/spaces/space-b', { active: 'no' })).status, 400);
  assert.deepEqual(await fotoDeTablas(db), antes);
}));

test('renombrar: id inexistente da 404 No encontrado', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  assert.deepEqual(await llamar(db, ADMIN, 'PUT', '/api/spaces/no-existe', { name: 'Nuevo' }), { status: 404, body: { error: 'No encontrado' } });
  assert.deepEqual(await fotoDeTablas(db), antes);
}));

test('renombrar: no cambia el código ni el estado activo del espacio', () => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  await crearEspacio(db, 'space-off', 'Apagado', 'OOOO-FFFF-OOOO', 0);
  await ping(db, APP); // siembra el código de Principal
  const filas = async () => db.all('SELECT id, code_hash, active, is_admin, created_at FROM spaces ORDER BY id');
  const antes = await filas();
  for (const id of ['space-b', 'space-off', 'space-admin']) {
    assert.equal((await llamar(db, ADMIN, 'PUT', `/api/spaces/${id}`, { name: `Renombrado ${id}` })).status, 200);
  }
  assert.deepEqual(await filas(), antes);
  assert.equal((await ping(db, CODE_B)).body.space.name, 'Renombrado space-b');
  assert.equal((await ping(db, APP)).body.space.name, 'Renombrado space-admin');
  assert.deepEqual(await ping(db, 'OOOO-FFFF-OOOO'), DESACTIVADO);
  // Los datos no se tocan.
  assert.deepEqual((await estado(db, CODE_B)).body.people.map((p) => p.id).sort(), ['pb', 'qb']);
}));

test('renombrar: un espacio de datos y quien no es administración reciben 404', async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  await conEntorno({ admin: ADMIN, app: APP }, async () => {
    for (const codigo of [CODE_B, APP]) {
      assert.deepEqual(await llamar(db, codigo, 'PUT', '/api/spaces/space-b', { name: 'Mío' }), NO_RUTA, codigo);
      assert.deepEqual(await llamar(db, codigo, 'PUT', '/api/spaces/space-b', { name: 123 }), NO_RUTA, codigo);
      assert.deepEqual(await llamar(db, codigo, 'PUT', '/api/spaces/no-existe', { name: 'Mío' }), NO_RUTA, codigo);
    }
  });
  await conEntorno({ admin: undefined, app: undefined }, async () => {
    assert.deepEqual(await llamar(db, undefined, 'PUT', '/api/spaces/space-b', { name: 'Mío' }), NO_RUTA);
    assert.deepEqual(await llamar(db, ADMIN, 'PUT', '/api/spaces/space-b', { name: 'Mío' }), NO_RUTA);
  });
  const despues = await fotoDeTablas(db);
  despues.spaces = despues.spaces.map((s) => (s.id === 'space-admin' ? { ...s, code_hash: null } : s)); // la siembra es lo único
  assert.deepEqual(despues, antes);
});

test('createSpace: crear un espacio con un nombre que no es cadena da 400 y no escribe nada',() => conEntorno({ admin: ADMIN, app: APP }, async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  for (const name of [123, 0, true, {}, [], ['Hola'], null, undefined]) {
    assert.equal((await llamar(db, ADMIN, 'POST', '/api/spaces', { name })).status, 400, `crear ${JSON.stringify(name)}`);
  }
  assert.equal((await llamar(db, ADMIN, 'POST', '/api/spaces', undefined)).status, 400);
  assert.deepEqual(await fotoDeTablas(db), antes);
  const ok = await llamar(db, ADMIN, 'POST', '/api/spaces', { name: '  Nuevo  ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, 'Nuevo');
}));

test('ADMIN_PASSCODE igual a APP_PASSCODE: abre la administración, nunca los datos de Principal', () => conEntorno({ admin: APP, app: APP }, async () => {
  const db = await conDatos();
  const antes = await fotoDeTablas(db);
  const respuestas = [await estado(db, APP), await ping(db, APP), await llamar(db, APP, 'GET', '/api/backup'), await llamar(db, APP, 'GET', '/api/trips')];
  const [e, p, respaldo, viajes] = respuestas;
  assert.equal(e.status, 200);
  assert.equal(e.body.space.is_manager, true);
  for (const k of ['trips', 'people', 'payment_methods', 'expenses', 'payments']) assert.deepEqual(e.body[k], [], k);
  assert.equal(p.body.space.is_manager, true);
  assert.deepEqual(respaldo, NO_RUTA);
  assert.deepEqual(viajes, NO_RUTA);
  assert.equal((await llamar(db, APP, 'GET', '/api/spaces')).status, 200);
  for (const r of respuestas) assert.ok(!JSON.stringify(r).match(/Persona|Taxi|Efectivo|trip-1/), JSON.stringify(r));
  assert.deepEqual(await fotoDeTablas(db), antes, 'ni siquiera se siembra Principal con ese código');
  assert.equal(await codigoDePrincipal(db), null);

  // Principal queda sin entrada hasta que la administración le regenere el código.
  const nuevo = await llamar(db, APP, 'POST', '/api/spaces/space-admin/regenerate');
  assert.equal(nuevo.status, 200);
  const dentro = await estado(db, nuevo.body.code);
  assert.equal(dentro.body.space.id, 'space-admin');
  assert.deepEqual(dentro.body.people.map((x) => x.id).sort(), ['pa', 'qa']);
  assert.equal((await estado(db, APP)).body.space.is_manager, true, 'APP_PASSCODE sigue siendo la administración');
}));
