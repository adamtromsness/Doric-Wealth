-- Generic assets & liabilities
-- Accounts (cash/investments/etc.) and vehicles have their own richer tables;
-- these two cover everything else you own or owe so the net-worth picture is whole.

-- ---------------------------------------------------------------------------
-- Assets you own that aren't an account or a vehicle: real estate, RVs,
-- airplanes, boats, equipment, collectibles, ...
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  asset_type     TEXT NOT NULL DEFAULT 'property'
                 CHECK (asset_type IN ('property','rv','airplane','boat','equipment','collectible','other')),
  value          NUMERIC(16,2),          -- current estimated value
  purchase_price NUMERIC(16,2),
  purchase_date  DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);

-- ---------------------------------------------------------------------------
-- Liabilities you owe that aren't already tracked as an account: mortgages,
-- auto/student/personal loans, medical debt, ...
-- (Credit-card and loan *accounts* still count as liabilities too.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS liabilities (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  liability_type  TEXT NOT NULL DEFAULT 'mortgage'
                  CHECK (liability_type IN ('mortgage','auto_loan','student_loan','personal_loan','credit_card','medical','other')),
  balance         NUMERIC(16,2),         -- current outstanding balance
  original_amount NUMERIC(16,2),
  interest_rate   NUMERIC(6,3),          -- annual % (e.g. 6.250)
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liabilities_type ON liabilities(liability_type);
