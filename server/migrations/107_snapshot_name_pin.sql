-- Snapshots are now a small managed set (max 5) the user curates: each can be named
-- and pinned so the auto-purge (which drops the oldest unpinned snapshot once over the
-- cap) leaves it alone. Additive & idempotent.
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS name   TEXT;
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
