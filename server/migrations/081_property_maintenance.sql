-- Property maintenance log: completed service/repair history (each optionally tied to
-- a transaction) plus scheduled "upcoming" items (e.g. next gutter cleaning by a date).
-- Mirrors vehicle_maintenance (065), minus the odometer columns. Additive & idempotent.
CREATE TABLE IF NOT EXISTS property_maintenance (
  id             SERIAL PRIMARY KEY,
  property_id    INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','upcoming')),
  service_date   DATE,                         -- when it was done (completed)
  cost           NUMERIC(16,2),                -- manual cost when no transaction is linked
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  due_date       DATE,                         -- when it's next due (upcoming)
  vendor         TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_maintenance_household ON property_maintenance(household_id);
CREATE INDEX IF NOT EXISTS idx_property_maintenance_property ON property_maintenance(property_id, status);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE property_maintenance ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE property_maintenance FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS property_maintenance_tenant_isolation ON property_maintenance';
  EXECUTE 'CREATE POLICY property_maintenance_tenant_isolation ON property_maintenance
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
