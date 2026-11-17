// Adaptador de base de datos con dos motores y la misma interfaz:
//  - local: node:sqlite (viene con Node, sin dependencias), archivo en ./data
//  - en línea: Turso por HTTP con @libsql/client/web (sin binarios nativos)
// Interfaz: all(sql, args) -> filas, run(sql, args), batch([{sql, args}]) en una transacción.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import schema from './schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);

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
  const rateCols = (await db.all('PRAGMA table_info(rates)')).map((c) => c.name);
  if (rateCols.length && !rateCols.includes('pair')) {
    await db.run('DROP TABLE rates'); // es solo un caché: se vuelve a pedir
  }
}

async function open(adapter) {
  await migrate(adapter);
  await adapter.batch(statements.map((sql) => ({ sql })));
  const existing = await adapter.all('SELECT value FROM settings WHERE key = ?', ['dest_currency']);
  if (!existing.length) {
    const hadExpenses = (await adapter.all('SELECT COUNT(*) AS n FROM expenses'))[0].n > 0;
    if (hadExpenses) {
      // Datos de la primera versión: eran reales a pesos colombianos.
      await adapter.batch([
        { sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', args: ['dest_currency', 'BRL'] },
        { sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', args: ['home_currency', 'COP'] },
      ]);
    }
  }
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
export function getDb() {
  cached ??= process.env.TURSO_DATABASE_URL
    ? openTurso(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN)
    : openLocal(process.env.DB_FILE ?? resolve(here, '..', 'data', 'gastos.db'));
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
