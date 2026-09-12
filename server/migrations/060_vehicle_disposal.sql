-- Vehicle disposal lifecycle: let a user retire a vehicle they no longer own
-- (sold, traded in, scrapped, totaled, gifted) WITHOUT deleting it. The vehicle
-- row and every transaction tagged to it are preserved for history; the vehicle
-- is simply marked disposed and drops out of current asset / net-worth totals.
-- Existing data is unaffected (all columns nullable; a NULL disposed_at = still owned).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS disposed_at     DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS disposal_type   TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS disposal_amount NUMERIC(16,2);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS disposal_note   TEXT;

-- Active-vehicle lookups (net worth, dashboard, asset totals) filter on this.
CREATE INDEX IF NOT EXISTS idx_vehicles_active
  ON vehicles(household_id)
  WHERE disposed_at IS NULL;
