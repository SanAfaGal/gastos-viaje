// Esquema de la base. Va como texto en JS para que funcione empaquetado en Netlify.
// Montos: enteros en centésimas. amount_cents = moneda del destino; amount_home = tu moneda.
export default `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  since INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  home_currency TEXT NOT NULL,
  created_at TEXT NOT NULL
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
  network TEXT
);

CREATE TABLE IF NOT EXISTS rates (
  pair TEXT NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
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
  rate_estimated INTEGER NOT NULL DEFAULT 0,
  rate_manual INTEGER NOT NULL DEFAULT 0,
  amount_home INTEGER,
  created_at TEXT NOT NULL,
  trip_id TEXT REFERENCES trips(id),
  lat REAL,
  lng REAL,
  place TEXT,
  amount_approx INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  pay_pending INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expense_beneficiaries (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (expense_id, person_id)
);
`;
