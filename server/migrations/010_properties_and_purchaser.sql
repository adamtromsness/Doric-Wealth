-- Who made a purchase (free text, e.g. a family member).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purchaser TEXT;
CREATE INDEX IF NOT EXISTS idx_txn_purchaser ON transactions(lower(purchaser));

-- Real estate, tracked as a rich first-class asset (like vehicles). current_value
-- counts toward net worth; mortgage_balance counts as a liability.
CREATE TABLE IF NOT EXISTS properties (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT,
  property_type   TEXT NOT NULL DEFAULT 'single_family'
                  CHECK (property_type IN ('single_family','condo','townhouse','multi_family','land','commercial','vacation','rental','other')),
  purchase_date   DATE,
  purchase_price  NUMERIC(16,2),
  current_value   NUMERIC(16,2),
  mortgage_balance NUMERIC(16,2),
  year_built      INTEGER,
  square_feet     INTEGER,
  rental_income   NUMERIC(16,2),   -- monthly, optional
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
