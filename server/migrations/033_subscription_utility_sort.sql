-- Manual ordering for the subscriptions and utility-account lists (drag to
-- reorder). Default 0 → new rows sort by name until explicitly ordered.
ALTER TABLE subscriptions    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
