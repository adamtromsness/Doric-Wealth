-- Manual ordering for vehicles & properties (drag-to-reorder on the list pages),
-- matching the accounts/utilities/subscriptions pattern. Additive & idempotent.
ALTER TABLE vehicles   ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
