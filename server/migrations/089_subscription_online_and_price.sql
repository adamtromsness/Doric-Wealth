-- Subscriptions: online-access contact fields (mirroring utilities/accounts) plus a
-- price-history ledger so plan price changes are tracked over time. Additive & idempotent.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS phone       TEXT;

CREATE TABLE IF NOT EXISTS subscription_price_history (
  id              SERIAL PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  amount          NUMERIC(16,2) NOT NULL,
  billing_cycle   TEXT,
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_price_history_sub ON subscription_price_history(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_price_history_household ON subscription_price_history(household_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE subscription_price_history ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE subscription_price_history FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS subscription_price_history_tenant_isolation ON subscription_price_history';
  EXECUTE 'CREATE POLICY subscription_price_history_tenant_isolation ON subscription_price_history
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
