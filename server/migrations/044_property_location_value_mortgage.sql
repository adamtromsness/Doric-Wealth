-- Properties: split the address into city/state/zip, link a mortgage to a real
-- liability account, and track value snapshots over time (mirroring account_balances).
-- Idempotent.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS zip TEXT;
-- When set, the property's mortgage is managed as this liability account (so the
-- debt is counted once — via the account — not also via properties.mortgage_balance).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS mortgage_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

-- Value history: the latest snapshot is the property's current value.
CREATE TABLE IF NOT EXISTS property_values (
  id           SERIAL PRIMARY KEY,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  as_of        DATE NOT NULL DEFAULT CURRENT_DATE,
  value        NUMERIC(16,2) NOT NULL,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_property_values_household ON property_values(household_id);
CREATE INDEX IF NOT EXISTS idx_property_values_property ON property_values(property_id);

-- Row-level security (defense-in-depth), matching migration 042's pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE property_values ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE property_values FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS property_values_tenant_isolation ON property_values';
  EXECUTE 'CREATE POLICY property_values_tenant_isolation ON property_values
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
