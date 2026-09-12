-- Recurring subscriptions (streaming, software, memberships, ...). Each renews
-- on a billing cycle; "log payment" records a real transaction against the
-- linked category/account and rolls the next renewal date forward.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  amount        NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly'
                CHECK (billing_cycle IN ('weekly','monthly','quarterly','yearly')),
  next_due_date DATE,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','canceled')),
  start_date    DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(next_due_date);
