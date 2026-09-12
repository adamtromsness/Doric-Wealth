-- Finance Tracker schema
-- Money is stored as NUMERIC (never floats). Dates are DATE; timestamps are TIMESTAMPTZ.

-- ---------------------------------------------------------------------------
-- Accounts: anything with a balance you want to track for net worth
-- (checking, savings, credit card, investment, loan, cash, or an asset like a car)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'checking'
              CHECK (type IN ('checking','savings','credit_card','investment','loan','cash','asset','other')),
  institution TEXT,
  currency    TEXT NOT NULL DEFAULT 'USD',
  -- liabilities (credit_card, loan) count against net worth
  is_liability BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Daily balance snapshots -> wealth / net-worth tracking over time
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_balances (
  id         SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of      DATE NOT NULL DEFAULT CURRENT_DATE,
  balance    NUMERIC(16,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_balances_account_date ON account_balances(account_id, as_of);

-- ---------------------------------------------------------------------------
-- Categories used by both budgets and transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income'))
);

-- ---------------------------------------------------------------------------
-- Budgets and their per-category allocations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  period     TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('weekly','monthly','yearly')),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id          SERIAL PRIMARY KEY,
  budget_id   INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  amount      NUMERIC(16,2) NOT NULL,
  UNIQUE (budget_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Vehicles -> cost of ownership analysis
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  make            TEXT,
  model           TEXT,
  year            INTEGER,
  vin             TEXT,
  purchase_date   DATE,
  purchase_price  NUMERIC(16,2),
  current_value   NUMERIC(16,2),
  odometer_start  INTEGER,
  odometer_current INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Transactions tracked against accounts / categories / (optionally) a vehicle
-- direction: 'expense' (money out) or 'income' (money in). amount is always positive.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  -- vehicle/property/subscription tags now live in line_tags (migration 019)
  txn_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  amount      NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  direction   TEXT NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income')),
  merchant    TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);

-- ---------------------------------------------------------------------------
-- Receipts: one optional receipt per transaction, with itemized products.
-- receipt_items are what let the AI analyze individual products you purchase.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id             SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  merchant       TEXT,
  purchased_at   DATE,
  subtotal       NUMERIC(16,2),
  tax            NUMERIC(16,2),
  total          NUMERIC(16,2),
  raw_text       TEXT,      -- paste OCR'd or typed receipt text here
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receipt_items (
  id          SERIAL PRIMARY KEY,
  receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,       -- product name, e.g. "Organic whole milk 1gal"
  product_category TEXT,           -- e.g. "dairy", "produce", "fuel"
  quantity    NUMERIC(14,3) NOT NULL DEFAULT 1,
  unit_price  NUMERIC(16,4),
  total_price NUMERIC(16,2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_items_name ON receipt_items(lower(name));

-- ---------------------------------------------------------------------------
-- Utility bills (electricity, gas, water, internet, ...), optionally tied to a transaction
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS utility_bills (
  id             SERIAL PRIMARY KEY,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  provider       TEXT NOT NULL,
  utility_type   TEXT NOT NULL DEFAULT 'electricity'
                 CHECK (utility_type IN ('electricity','gas','water','sewer','trash','internet','phone','other')),
  period_start   DATE,
  period_end     DATE,
  usage_quantity NUMERIC(16,3),    -- e.g. 845 (kWh)
  usage_unit     TEXT,             -- 'kWh','therm','gallon','GB', ...
  amount         NUMERIC(16,2) NOT NULL,
  due_date       DATE,
  paid           BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utility_type ON utility_bills(utility_type);
CREATE INDEX IF NOT EXISTS idx_utility_period ON utility_bills(period_start, period_end);

-- ---------------------------------------------------------------------------
-- Saved AI analysis results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_analyses (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,       -- 'vehicle_tco' | 'receipt_products' | 'spending_overview' | 'custom'
  subject_id INTEGER,             -- e.g. vehicle id for vehicle_tco
  title      TEXT,
  result     TEXT NOT NULL,       -- markdown
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_kind ON ai_analyses(kind, created_at DESC);
