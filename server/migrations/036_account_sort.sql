-- Manual ordering for the accounts list (drag-to-reorder, within each type group).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
