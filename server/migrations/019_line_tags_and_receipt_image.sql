-- Many-to-many tags: a transaction OR one of its splits can carry any number of
-- vehicle / property / subscription tags (e.g. a vehicle AND a subscription on
-- the same line). Replaces the single vehicle_id/property_id/subscription_id
-- columns as the source of truth for tag rollups.
CREATE TABLE IF NOT EXISTS line_tags (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  split_id INTEGER REFERENCES transaction_splits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('vehicle','property','subscription')),
  ref_id INTEGER NOT NULL,
  -- A tag hangs off exactly one owner: the transaction itself, or one split of it.
  CONSTRAINT line_tags_owner_chk CHECK ((transaction_id IS NOT NULL) <> (split_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS line_tags_txn_idx ON line_tags(transaction_id);
CREATE INDEX IF NOT EXISTS line_tags_split_idx ON line_tags(split_id);
CREATE INDEX IF NOT EXISTS line_tags_ref_idx ON line_tags(kind, ref_id);

-- (A one-time backfill from the legacy single-column tags ran here originally.
-- Those columns were since removed from the create migrations and dropped in
-- migration 020, so the backfill is gone to keep a fresh build consistent.)

-- Receipt image: store the uploaded photo/PDF that an AI vision pass can parse.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS image BYTEA;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS image_mime TEXT;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS original_name TEXT;
