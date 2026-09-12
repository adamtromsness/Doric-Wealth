-- Vehicle maintenance log: completed service history (each optionally tied to a
-- transaction) plus scheduled "upcoming" items (e.g. next oil change by a date or
-- odometer). Additive & idempotent.
CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id             SERIAL PRIMARY KEY,
  vehicle_id     INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','upcoming')),
  service_date   DATE,                         -- when it was done (completed)
  odometer       INTEGER,                      -- mileage at service (completed)
  cost           NUMERIC(16,2),                -- manual cost when no transaction is linked
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  due_date       DATE,                         -- when it's next due (upcoming)
  due_odometer   INTEGER,                      -- mileage it's next due at (upcoming)
  vendor         TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_household ON vehicle_maintenance(household_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_vehicle ON vehicle_maintenance(vehicle_id, status);

-- Row-level security (defense-in-depth), matching the vehicle_documents pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE vehicle_maintenance ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vehicle_maintenance FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS vehicle_maintenance_tenant_isolation ON vehicle_maintenance';
  EXECUTE 'CREATE POLICY vehicle_maintenance_tenant_isolation ON vehicle_maintenance
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
