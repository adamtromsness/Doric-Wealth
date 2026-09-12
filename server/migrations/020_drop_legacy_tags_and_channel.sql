-- Drop the legacy single-column tags now that line_tags (migration 019) is the
-- sole source of truth. The 019 backfill has already copied these into line_tags.
ALTER TABLE transactions DROP COLUMN IF EXISTS vehicle_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS property_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS subscription_id;
ALTER TABLE transaction_splits DROP COLUMN IF EXISTS vehicle_id;
ALTER TABLE transaction_splits DROP COLUMN IF EXISTS property_id;
ALTER TABLE transaction_splits DROP COLUMN IF EXISTS subscription_id;

-- Purchase channel: whether the transaction happened online or in a store.
-- NULL means unspecified.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS channel TEXT
  CHECK (channel IN ('online','in_store'));
