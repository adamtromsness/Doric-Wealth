-- Investment account composition (holdings/positions) pulled from a linked provider
-- (SimpleFIN). Current-snapshot model: an account's holdings are fully replaced on
-- each sync, so this table always reflects the latest reported positions. Additive &
-- idempotent; RLS mirrors migration 042.
CREATE TABLE IF NOT EXISTS account_holdings (
  id            SERIAL PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id   TEXT,                -- provider's holding id
  symbol        TEXT,
  description   TEXT,
  shares        NUMERIC(20,6),
  market_value  NUMERIC(16,2),
  cost_basis    NUMERIC(16,2),
  currency      TEXT,
  as_of         DATE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_holdings_household ON account_holdings(household_id);
CREATE INDEX IF NOT EXISTS idx_account_holdings_account ON account_holdings(account_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE account_holdings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE account_holdings FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS account_holdings_tenant_isolation ON account_holdings';
  EXECUTE 'CREATE POLICY account_holdings_tenant_isolation ON account_holdings
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
