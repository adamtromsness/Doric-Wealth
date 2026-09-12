-- Give standalone liabilities a real detail page: extra loan fields plus opt-in
-- capability tabs (balance-paydown history + documents), mirroring assets.
-- Additive & idempotent.
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS lender          TEXT;
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS account_number  TEXT;
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS due_day         INTEGER;
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS minimum_payment NUMERIC(16,2);
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS opened_date     DATE;
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS payoff_date     DATE;
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS tracks_balance  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS has_documents   BOOLEAN NOT NULL DEFAULT false;

-- Balance-owed snapshots over time (latest drives the current balance).
CREATE TABLE IF NOT EXISTS liability_balances (
  id           SERIAL PRIMARY KEY,
  liability_id INTEGER NOT NULL REFERENCES liabilities(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  as_of        DATE NOT NULL,
  balance      NUMERIC(16,2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (liability_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_liability_balances_liability ON liability_balances(liability_id);

CREATE TABLE IF NOT EXISTS liability_documents (
  id           SERIAL PRIMARY KEY,
  liability_id INTEGER NOT NULL REFERENCES liabilities(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL DEFAULT 'other',
  name         TEXT,
  file         BYTEA,
  file_mime    TEXT,
  file_name    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liability_documents_liability ON liability_documents(liability_id);

DO $$
DECLARE tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['liability_balances','liability_documents']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_isolation', tbl);
    EXECUTE format('CREATE POLICY %I ON %I USING (household_id = current_setting(''app.household_id'', true)::int) WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)', tbl || '_tenant_isolation', tbl);
  END LOOP;
END $$;
