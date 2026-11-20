// Adaptador de base de datos con dos motores y la misma interfaz:
//  - local: node:sqlite (viene con Node, sin dependencias), archivo en ./data
//  - en línea: Turso por HTTP con @libsql/client/web (sin binarios nativos)
// Interfaz: all(sql, args) -> filas, run(sql, args), batch([{sql, args}]) en una transacción.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import schema from './schema.mjs';
import { currencyByCode, DEFAULT_SETTINGS } from '../public/js/currencies.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Espacio que existe siempre y agrupa lo anterior a los espacios (lo reexporta spaces.mjs).
export const ADMIN_SPACE_ID = 'space-admin';

const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);

// Agrega una columna si falta. Dos instancias que arrancan a la vez pueden leer el esquema viejo y correr las dos el
// ALTER: la segunda falla con "duplicate column", que solo significa que la otra ya la agregó. Cualquier otro error
// se propaga. `table`, `col` y `type` son textos fijos de este archivo, nunca datos de una petición.
async function addColumn(db, table, col, type) {
  try {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (err) {
    if (!/duplicate column/i.test(err?.message ?? '')) throw err;
  }
}

// Bases creadas con la primera versión (solo BRL -> COP): renombra columnas y pasa los pesos a centésimas.
async function migrate(db) {
  const cols = (await db.all('PRAGMA table_info(expenses)')).map((c) => c.name);
  if (cols.includes('amount_brl_cents')) {
    await db.batch([
      { sql: 'ALTER TABLE expenses RENAME COLUMN amount_brl_cents TO amount_cents' },
      { sql: 'ALTER TABLE expenses RENAME COLUMN rate_cop_per_brl TO rate' },
      { sql: 'ALTER TABLE expenses RENAME COLUMN amount_cop TO amount_home' },
      { sql: 'UPDATE expenses SET amount_home = amount_home * 100 WHERE amount_home IS NOT NULL' },
    ]);
  }
  // Medios de pago con aspecto de tarjeta: color y red (opcionales).
  const methodCols = (await db.all('PRAGMA table_info(payment_methods)')).map((c) => c.name);
  if (methodCols.length) {
    for (const col of ['color', 'network']) {
      if (!methodCols.includes(col)) await addColumn(db, 'payment_methods', col, 'TEXT');
    }
  }
  const rateCols =(await db.all('PRAGMA table_info(rates)')).map((c) => c.name);
  if (rateCols.length && !rateCols.includes('pair')) {
    await db.run('DROP TABLE rates'); // es solo un caché: se vuelve a pedir
  }
}

// Varios viajes: siempre existe al menos uno. Las bases anteriores (un solo viaje) pasan a "Viaje 1" con las
// monedas que tenían en ajustes (o BRL/COP, que era lo de la primera versión), con todos sus gastos y todas
// sus personas. Es idempotente: corre en cada arranque, y el id fijo evita duplicados si dos arrancan a la vez.
async function upgradeTrips(db) {
  const cols = (await db.all('PRAGMA table_info(expenses)')).map((c) => c.name);
  if (!cols.includes('trip_id')) await addColumn(db, 'expenses', 'trip_id', 'TEXT REFERENCES trips(id)');

  // Ubicación opcional del gasto y marca de monto aproximado.
  const extra = [
    ['lat', 'REAL'],
    ['lng', 'REAL'],
    ['place', 'TEXT'],
    ['amount_approx', 'INTEGER NOT NULL DEFAULT 0'],
    ['sort_order', 'INTEGER'], // orden manual dentro del día (vacío = por hora de creación, al final)
    ['pay_pending', 'INTEGER NOT NULL DEFAULT 0'], // 1 = medio de pago por definir (payment_method_id es solo relleno)
    ['rate_source', 'TEXT'], // fuente de la tasa del gasto (vacío = guardada antes de registrarla)
    ['currency', 'TEXT'], // moneda del gasto (vacío = la del destino del viaje)
  ];
  for (const [col, type] of extra) {
    if (!cols.includes(col)) await addColumn(db, 'expenses', col, type);
  }
  // Fuente y momento de consulta de cada tasa guardada.
  const rateCols = (await db.all('PRAGMA table_info(rates)')).map((c) => c.name);
  for (const col of ['source', 'fetched_at']) {
    if (!rateCols.includes(col)) await addColumn(db, 'rates', col, 'TEXT');
  }

  const first = () => db.all('SELECT id FROM trips ORDER BY rowid LIMIT 1');
  if (!(await first()).length) {
    const rows = await db.all("SELECT key, value FROM settings WHERE key IN ('dest_currency', 'home_currency')");
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const dest = currencyByCode(s.dest_currency) ? s.dest_currency : DEFAULT_SETTINGS.dest;
    const home = currencyByCode(s.home_currency) ? s.home_currency : DEFAULT_SETTINGS.home;
    await db.batch([
      {
        sql: 'INSERT OR IGNORE INTO trips (id, name, dest_currency, home_currency, created_at) VALUES (?, ?, ?, ?, ?)',
        args: ['trip-1', 'Viaje 1', dest, home, new Date().toISOString()],
      },
      { sql: 'INSERT OR IGNORE INTO trip_people (trip_id, person_id) SELECT ?, id FROM people', args: ['trip-1'] },
    ]);
  }
  await db.run('UPDATE expenses SET trip_id = ? WHERE trip_id IS NULL', [(await first())[0].id]);
}

// Espacios: personas, viajes y medios de pago pertenecen a un espacio. Las bases anteriores (y el viaje inicial que
// acaba de crear upgradeTrips) pasan al espacio administrador. Es idempotente: corre en cada arranque, y el
// INSERT OR IGNORE evita duplicar al administrador si dos instancias arrancan a la vez.
async function upgradeSpaces(db) {
  const tables = ['people', 'trips', 'payment_methods'];
  for (const table of tables) {
    const cols = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
    if (!cols.includes('space_id')) await addColumn(db, table, 'space_id', 'TEXT REFERENCES spaces(id)');
  }
  await db.run(
    'INSERT OR IGNORE INTO spaces (id, name, code_hash, is_admin, active, created_at) VALUES (?, ?, NULL, 1, 1, ?)',
    [ADMIN_SPACE_ID, 'Principal', new Date().toISOString()],
  );
  for (const table of tables) {
    await db.run(`UPDATE ${table} SET space_id = ? WHERE space_id IS NULL`, [ADMIN_SPACE_ID]);
  }
}

// Columnas que eran calculables y ya no se guardan: el monto en tu moneda (amount_home) sale de amount_cents y la tasa;
// "tasa estimada" (rate_estimated) es que el día de la tasa no sea el del gasto; y rate_manual ya no existe (siempre 0).
// Solo se borran del esquema; el servidor las calcula al leer. Es idempotente.
async function dropDerivedColumns(db) {
  const cols = (await db.all('PRAGMA table_info(expenses)')).map((c) => c.name);
  for (const col of ['rate_estimated', 'rate_manual', 'amount_home']) {
    if (!cols.includes(col)) continue;
    try {
      await db.run(`ALTER TABLE expenses DROP COLUMN ${col}`);
    } catch (err) {
      if (!/no such column/i.test(err?.message ?? '')) throw err; // otra instancia ya la borró
    }
  }
}

async function open(adapter) {
  await migrate(adapter);
  await adapter.batch(statements.map((sql) => ({ sql })));
  await upgradeTrips(adapter);
  await upgradeSpaces(adapter);
  await dropDerivedColumns(adapter);
  return adapter;
}

async function openLocal(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  const rows = (sql, args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
  return open({
    async all(sql, args = []) {
      return rows(sql, args);
    },
    async run(sql, args = []) {
      db.prepare(sql).run(...args);
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const s of stmts) db.prepare(s.sql).run(...(s.args ?? []));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  });
}

async function openTurso(url, authToken) {
  const { createClient } = await import('@libsql/client/web');
  const client = createClient({ url, authToken });
  return open({
    async all(sql, args = []) {
      const res = await client.execute({ sql, args });
      return res.rows.map((r) => ({ ...r }));
    },
    async run(sql, args = []) {
      await client.execute({ sql, args });
    },
    async batch(stmts) {
      await client.batch(stmts.map((s) => ({ sql: s.sql, args: s.args ?? [] })), 'write');
    },
  });
}

let cached;

// Con TURSO_DATABASE_URL usa Turso; si no, un archivo local (DB_FILE o ./data/gastos.db).
// Si abrir falla (la base no responde, una migración choca), no se guarda la falla: la próxima petición vuelve a
// intentar en vez de responder 500 hasta que se reinicie la instancia.
export function getDb() {
  if (!cached) {
    const opening = process.env.TURSO_DATABASE_URL
      ? openTurso(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN)
      : openLocal(process.env.DB_FILE ?? resolve(here, '..', 'data', 'gastos.db'));
    cached = opening;
    opening.catch(() => {
      if (cached === opening) cached = undefined;
    });
  }
  return cached;
}

// Solo para pruebas: abre un archivo concreto (para probar migraciones).
export function openFileDb(file) {
  return openLocal(file);
}

// Solo para pruebas: base nueva en memoria.
export function openMemoryDb() {
  return openLocal(':memory:');
}
