-- Documents are categorised by type (title, insurance, maintenance, …) so they can
-- be grouped in the vehicle's Documents section. Existing maintenance-linked docs
-- are backfilled to the 'maintenance' type. Additive & idempotent.
ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'other';
UPDATE vehicle_documents SET doc_type = 'maintenance' WHERE maintenance_id IS NOT NULL AND doc_type = 'other';
