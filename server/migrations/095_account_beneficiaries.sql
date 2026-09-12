-- Structured beneficiaries for an account (replaces the free-text accounts.beneficiaries
-- for accounts that opt into the Beneficiaries capability). Additive & idempotent.
CREATE TABLE IF NOT EXISTS account_beneficiaries (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  relationship TEXT,
  kind         TEXT NOT NULL DEFAULT 'primary',  -- primary | contingent
  percentage   NUMERIC(6,2),
  notes        TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_beneficiaries_account ON account_beneficiaries(account_id);
CREATE INDEX IF NOT EXISTS idx_account_beneficiaries_household ON account_beneficiaries(household_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE account_beneficiaries ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE account_beneficiaries FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS account_beneficiaries_tenant_isolation ON account_beneficiaries';
  EXECUTE 'CREATE POLICY account_beneficiaries_tenant_isolation ON account_beneficiaries
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
