-- Odometer reading history: a dated snapshot of the vehicle's mileage, like
-- property value snapshots. The latest reading drives the vehicle's current
-- odometer (and everything derived from it: miles driven, cost/mile, warranty
-- mileage tracking). Additive & idempotent.
CREATE TABLE IF NOT EXISTS vehicle_odometer_readings (
  id           SERIAL PRIMARY KEY,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  as_of        DATE NOT NULL DEFAULT CURRENT_DATE,
  reading      INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_household ON vehicle_odometer_readings(household_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_vehicle ON vehicle_odometer_readings(vehicle_id, as_of);

-- Row-level security (defense-in-depth), matching the vehicle_documents pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE vehicle_odometer_readings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vehicle_odometer_readings FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS vehicle_odometer_readings_tenant_isolation ON vehicle_odometer_readings';
  EXECUTE 'CREATE POLICY vehicle_odometer_readings_tenant_isolation ON vehicle_odometer_readings
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
