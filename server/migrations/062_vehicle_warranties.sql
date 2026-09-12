-- Warranties become one-to-many: a vehicle can have several (powertrain,
-- bumper-to-bumper, extended, tire/wheel, …). Replaces the single warranty_*
-- columns added in 061. Additive table + a guarded backfill/drop so it's
-- re-runnable.

CREATE TABLE IF NOT EXISTS vehicle_warranties (
  id           SERIAL PRIMARY KEY,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  coverage     TEXT,        -- e.g. "Powertrain", "Bumper-to-bumper", "Extended"
  provider     TEXT,
  expiration   DATE,
  miles        INTEGER,
  notes        TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_warranties_household ON vehicle_warranties(household_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_warranties_vehicle ON vehicle_warranties(vehicle_id);

-- Row-level security (defense-in-depth), matching the vehicle_documents pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE vehicle_warranties ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vehicle_warranties FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS vehicle_warranties_tenant_isolation ON vehicle_warranties';
  EXECUTE 'CREATE POLICY vehicle_warranties_tenant_isolation ON vehicle_warranties
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;

-- Migrate any existing single-column warranty into a row, then drop the columns.
-- Guarded on the column still existing, so a replay is a no-op (and won't duplicate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'vehicles' AND column_name = 'warranty_provider') THEN
    INSERT INTO vehicle_warranties (vehicle_id, household_id, provider, expiration, miles, notes)
    SELECT id, household_id, warranty_provider, warranty_expiration, warranty_miles, warranty_notes
    FROM vehicles
    WHERE warranty_provider IS NOT NULL OR warranty_expiration IS NOT NULL
       OR warranty_miles IS NOT NULL OR warranty_notes IS NOT NULL;

    ALTER TABLE vehicles DROP COLUMN warranty_provider;
    ALTER TABLE vehicles DROP COLUMN warranty_expiration;
    ALTER TABLE vehicles DROP COLUMN warranty_miles;
    ALTER TABLE vehicles DROP COLUMN warranty_notes;
  END IF;
END $$;
