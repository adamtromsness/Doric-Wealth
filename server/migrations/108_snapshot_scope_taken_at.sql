-- Snapshots now record whether they cover the full dataset or a subset (scope), and
-- the moment the data was actually captured (taken_at = the envelope's exported_at).
-- taken_at lets an uploaded snapshot show its ORIGINAL creation time, not the upload
-- time. Additive & idempotent; backfill taken_at from the existing row timestamp.
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS scope    TEXT NOT NULL DEFAULT 'full';  -- full | partial
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;
UPDATE backup_snapshots SET taken_at = created_at WHERE taken_at IS NULL;
