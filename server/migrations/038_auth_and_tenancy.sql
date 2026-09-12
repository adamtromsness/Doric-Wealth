-- Multi-tenancy + auth foundation (Phase 1).
-- Adds the household/user/membership/session/invite tables, and a nullable
-- household_id on every existing data table. household_id is left nullable here so
-- routes that have not yet been tenant-scoped keep working during the transition;
-- migration 040 enforces NOT NULL on the tables wired in Phase 1 (accounts,
-- transactions and their children). Backfill of existing rows happens in 039.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS households (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness for email (no citext dependency).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS memberships (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, household_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_household ON memberships(household_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  active_household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id           SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  code         TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ,
  max_uses     INTEGER,
  uses         INTEGER NOT NULL DEFAULT 0,
  revoked      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_household ON invites(household_id);

-- Add a nullable household_id (+ index) to every ownable data table.
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'accounts','account_balances','transactions','transaction_splits','line_tags',
    'categories','receipts','receipt_items','budgets','budget_lines','budget_accounts',
    'goals','subscriptions','utility_accounts','utility_invoices','utility_invoice_lines',
    'utility_invoice_payments','vehicles','properties','assets','liabilities','ai_analyses'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS household_id INTEGER REFERENCES households(id) ON DELETE CASCADE', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_household ON %I(household_id)', t, t);
    END IF;
  END LOOP;
END $$;
