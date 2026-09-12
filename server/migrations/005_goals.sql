-- Financial goals. One flexible table covers three kinds:
--   savings        -> grow a balance toward target_amount (current pulled from a
--                     linked account/asset, or entered manually)
--   reduce_spending-> keep spending in a category at/under target_amount per period
--   debt_payoff    -> pay a liability/loan from baseline_amount down to target_amount (usually 0)
CREATE TABLE IF NOT EXISTS goals (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  goal_type       TEXT NOT NULL CHECK (goal_type IN ('savings','reduce_spending','debt_payoff')),
  target_amount   NUMERIC(16,2),
  current_amount  NUMERIC(16,2),                 -- manual current value when nothing is linked
  baseline_amount NUMERIC(16,2),                 -- debt payoff starting balance
  period          TEXT CHECK (period IN ('weekly','monthly','yearly')),  -- reduce_spending window
  account_id      INTEGER REFERENCES accounts(id)    ON DELETE SET NULL,
  category_id     INTEGER REFERENCES categories(id)  ON DELETE SET NULL,
  liability_id    INTEGER REFERENCES liabilities(id) ON DELETE SET NULL,
  asset_id        INTEGER REFERENCES assets(id)      ON DELETE SET NULL,
  target_date     DATE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
