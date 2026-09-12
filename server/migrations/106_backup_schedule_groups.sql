-- The scheduled backup can target a subset of data sets (the same selection used for a
-- manual download), not just the full snapshot. Stored as a comma-separated list of
-- group keys; NULL = all data sets. Additive & idempotent.
ALTER TABLE household_backup_settings ADD COLUMN IF NOT EXISTS groups TEXT;
