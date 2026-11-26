// Esquema de la base. Va como texto en JS para que funcione empaquetado en Netlify.
//
// Montos: enteros en centésimas. amount_cents = moneda del destino. El monto en tu moneda NO se guarda: se calcula
// al leer como amount_cents por la tasa del gasto (getState en handlers.mjs).
//
// Tasa del gasto (expenses.rate y expenses.rate_date): es un registro del gasto, como el recibo, y no se recalcula
// en vivo. rate es la tasa que se usó y rate_date el día al que pertenece (si no es el del gasto, la tasa es
// estimada). Se guarda en el gasto porque la tasa de hoy aún no es definitiva y no está en la tabla rates, porque la
// fuente gratuita puede dar valores distintos según la hora o cambiar su historial, y porque la app debe mostrar los
// mismos montos sin internet. La tabla rates es solo un caché de días ya cerrados (se puede borrar y se vuelve a pedir).
// Un gasto de un día cerrado se corrige solo cuando su tasa difiere de la de rates (fillPendingRates).
// Trazabilidad: cada tasa guarda de qué fuente salió (rates.source y expenses.rate_source) y rates.fetched_at, cuándo se
// consultó. Vacío = guardada antes de que se registrara la fuente.
//
// Moneda del gasto (expenses.currency): vacío = la moneda del destino del viaje, así los gastos anteriores no cambian.
// Con otra moneda (la de casa, por ejemplo un vuelo comprado en Colombia, o la de un tercer país) amount_cents está en
// esa moneda y la tasa es la de ese par hacia la moneda de casa (1 si ya es la de casa).
//
// Espacios: cada código de acceso abre un espacio separado, con sus propias personas, viajes y medios de pago. Siempre
// existe el espacio Principal (id space-admin) que agrupa lo creado antes de los espacios. is_admin y ese id son
// históricos: is_admin ya no decide permisos (la administración no es un espacio y no tiene fila aquí). code_hash es
// el resumen del código (nunca el código) y es único. active = 0 deja el espacio sin acceso sin borrar sus datos.
//
// No usar punto y coma dentro de los comentarios de este archivo: el esquema se parte por punto y coma.
export default `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  since INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS spaces_code ON spaces(code_hash);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  home_currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS trip_people (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (trip_id, person_id)
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'pix', 'cash')),
  name TEXT NOT NULL,
  last4 TEXT,
  card_type TEXT CHECK (card_type IN ('debit', 'credit')),
  owner_person_id TEXT NOT NULL REFERENCES people(id),
  color TEXT,
  network TEXT,
  space_id TEXT REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS rates (
  pair TEXT NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  source TEXT,
  fetched_at TEXT,
  PRIMARY KEY (pair, date)
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payment_method_id TEXT NOT NULL REFERENCES payment_methods(id),
  rate REAL,
  rate_date TEXT,
  rate_source TEXT,
  created_at TEXT NOT NULL,
  trip_id TEXT REFERENCES trips(id),
  lat REAL,
  lng REAL,
  place TEXT,
  amount_approx INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  pay_pending INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  amount_pending INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expense_beneficiaries (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (expense_id, person_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  from_person_id TEXT NOT NULL REFERENCES people(id),
  to_person_id TEXT NOT NULL REFERENCES people(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT,
  rate REAL,
  rate_date TEXT,
  rate_source TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;
