-- Account lifecycle (archive/close), reconciliation sessions + their cleared
-- items, per-account import status, and an append-only balance-adjustment audit
-- log. Every new table is household-scoped with row-level security (matching
-- migrations 042/049). Additive + idempotent + safe for existing installs.

-- 1. Account lifecycle fields. Status is derived in the API (closed > archived >
--    active), so no stored status column is needed.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS closed_at    DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS close_reason TEXT;

-- 2. Reconciliation sessions (one statement reconciliation for an account).
CREATE TABLE IF NOT EXISTS reconciliation_sessions (
  id                 SERIAL PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  statement_start    DATE,
  statement_end      DATE,
  statement_balance  NUMERIC(16,2),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','canceled')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recon_sessions_household ON reconciliation_sessions(household_id);
CREATE INDEX IF NOT EXISTS idx_recon_sessions_account ON reconciliation_sessions(account_id);

-- 3. Reconciliation items: transactions marked cleared within a session.
CREATE TABLE IF NOT EXISTS reconciliation_items (
  id             SERIAL PRIMARY KEY,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  session_id     INTEGER NOT NULL REFERENCES reconciliation_sessions(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  cleared        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_recon_items_household ON reconciliation_items(household_id);
CREATE INDEX IF NOT EXISTS idx_recon_items_session ON reconciliation_items(session_id);

-- 4. Per-account import status (one row per account).
CREATE TABLE IF NOT EXISTS account_import_status (
  id                 SERIAL PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  provider           TEXT,
  last_import_at     TIMESTAMPTZ,
  last_import_status TEXT,
  last_import_error  TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_import_status_household ON account_import_status(household_id);

-- 5. Append-only balance-adjustment audit log. Only ever INSERTed (the app
--    exposes no update/delete), so it preserves a full history of manual changes.
CREATE TABLE IF NOT EXISTS balance_adjustments (
  id                 SERIAL PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  adjustment_date    DATE NOT NULL,
  previous_balance   NUMERIC(16,2),
  new_balance        NUMERIC(16,2) NOT NULL,
  reason             TEXT,
  source             TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_balance_adjustments_household ON balance_adjustments(household_id);
CREATE INDEX IF NOT EXISTS idx_balance_adjustments_account ON balance_adjustments(account_id);

-- Row-level security for the new tenant tables (matches migration 042/049).
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY['reconciliation_sessions','reconciliation_items','account_import_status','balance_adjustments'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (household_id = current_setting(''app.household_id'', true)::int)
         WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
