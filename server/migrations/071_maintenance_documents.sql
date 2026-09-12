-- Allow a vehicle document to be attached to a specific maintenance record
-- (e.g. a service invoice or receipt). When NULL the document belongs to the
-- vehicle generally (the existing behaviour). Additive & idempotent.
ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS maintenance_id INTEGER REFERENCES vehicle_maintenance(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_maintenance ON vehicle_documents(maintenance_id);
