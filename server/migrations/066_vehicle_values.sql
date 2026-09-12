-- Vehicle value snapshots over time (like property value snapshots). The latest
-- snapshot drives the vehicle's current_value (what net worth uses). Additive &
-- idempotent.
CREATE TABLE IF NOT EXISTS vehicle_values (
  id           SERIAL PRIMARY KEY,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  as_of        DATE NOT NULL DEFAULT CURRENT_DATE,
  value        NUMERIC(16,2) NOT NULL,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_values_household ON vehicle_values(household_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_values_vehicle ON vehicle_values(vehicle_id, as_of);

-- Row-level security (defense-in-depth), matching the vehicle_documents pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE vehicle_values ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vehicle_values FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS vehicle_values_tenant_isolation ON vehicle_values';
  EXECUTE 'CREATE POLICY vehicle_values_tenant_isolation ON vehicle_values
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
