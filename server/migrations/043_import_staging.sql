-- CSV / auto import staging. Uploaded (or future auto-loaded) transactions land in
-- staged_transactions for review; they do NOT touch balances/budgets/net worth until
-- the user confirms each one, at which point a real (posted) transaction is created.
-- New tables start empty, so household_id is NOT NULL from the start (no backfill) and
-- RLS is enabled inline. Idempotent.

CREATE TABLE IF NOT EXISTS import_batches (
  id              SERIAL PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  filename        TEXT,
  source          TEXT NOT NULL DEFAULT 'csv',
  total_rows      INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_batches_household ON import_batches(household_id);

CREATE TABLE IF NOT EXISTS staged_transactions (
  id            SERIAL PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  batch_id      INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'csv',
  account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  txn_date      DATE,
  amount        NUMERIC(16,2),
  direction     TEXT NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income','transfer')),
  merchant      TEXT,
  raw_merchant  TEXT,
  description   TEXT,
  raw           JSONB,
  duplicate_of  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  decision      TEXT NOT NULL DEFAULT 'import' CHECK (decision IN ('import','skip')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staged_transactions_household ON staged_transactions(household_id);
CREATE INDEX IF NOT EXISTS idx_staged_transactions_batch ON staged_transactions(batch_id);

-- Row-level security (defense-in-depth), matching migration 042's pattern.
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY['import_batches','staged_transactions'];
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
