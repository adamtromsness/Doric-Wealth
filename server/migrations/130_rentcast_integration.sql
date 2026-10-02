-- RentCast as a per-book integration, plus automatic property value updates.
-- Additive and idempotent.

-- A book's RentCast API key, encrypted at rest ("enc1:" + AES-256-GCM, see
-- secrets.ts). NULL = use the server's RENTCAST_API_KEY, if any. `books` is an
-- identity table (no row-level security); routes scope it to the active book.
ALTER TABLE books ADD COLUMN IF NOT EXISTS rentcast_api_key TEXT;

-- Per-property automatic value updates from RentCast. The background job records a
-- dated value snapshot each period. last_attempt_at paces retries after a failure
-- (at most one try a day); last_success_at drives the weekly/monthly schedule.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS auto_value_enabled         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS auto_value_frequency       TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS auto_value_last_attempt_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS auto_value_last_success_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS auto_value_last_error      TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_auto_value_frequency_check') THEN
    ALTER TABLE properties ADD CONSTRAINT properties_auto_value_frequency_check
      CHECK (auto_value_frequency IN ('weekly', 'monthly'));
  END IF;
END $$;

-- Where a value snapshot came from: 'manual' (entered), 'rentcast' (automatic or
-- estimate), 'ai' (AI estimate). NULL for snapshots recorded before this.
ALTER TABLE property_values ADD COLUMN IF NOT EXISTS source TEXT;
