-- Remembers merchants the user has chosen to ignore when offered as a likely
-- subscription, so detection stops suggesting them. Idempotent.
CREATE TABLE IF NOT EXISTS ignored_subscription_merchants (
  id           SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  merchant     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ignored_sub_merchants_household ON ignored_subscription_merchants(household_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ignored_sub_merchants ON ignored_subscription_merchants(household_id, lower(merchant));

-- Row-level security (defense-in-depth), matching migration 042's pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE ignored_subscription_merchants ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ignored_subscription_merchants FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS ignored_subscription_merchants_tenant_isolation ON ignored_subscription_merchants';
  EXECUTE 'CREATE POLICY ignored_subscription_merchants_tenant_isolation ON ignored_subscription_merchants
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
