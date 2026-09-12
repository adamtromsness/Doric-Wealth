-- Vehicles: attached documents (bill of sale, title, service records, photos),
-- warranty details, and an optional link from a disposal to the transaction that
-- recorded the sale proceeds. All additive & idempotent.

-- Warranty info.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS warranty_provider   TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS warranty_expiration DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS warranty_miles      INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS warranty_notes      TEXT;

-- When a sale/trade-in is tied to a real transaction (existing or newly created),
-- this links the vehicle's disposal to it. SET NULL if that transaction is deleted.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS disposal_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;

-- Documents/images attached to a vehicle (title, bill of sale, service records, …).
-- Bytes stored inline like property documents; not loaded with the vehicle list.
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id           SERIAL PRIMARY KEY,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT,
  file         BYTEA,
  file_mime    TEXT,
  file_name    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_household ON vehicle_documents(household_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle ON vehicle_documents(vehicle_id);

-- Row-level security (defense-in-depth), matching the property_documents pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE vehicle_documents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vehicle_documents FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS vehicle_documents_tenant_isolation ON vehicle_documents';
  EXECUTE 'CREATE POLICY vehicle_documents_tenant_isolation ON vehicle_documents
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
