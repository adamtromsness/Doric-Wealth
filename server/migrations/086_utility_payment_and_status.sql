-- Utility account: provider website, autopay scheduling + paid-from account,
-- payment plan (actual vs budget/average billing), and a cancel/disable status
-- (mirrors subscriptions; a future end_date schedules the cancellation). Additive.
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS provider_url       TEXT;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS autopay_day        INTEGER CHECK (autopay_day IS NULL OR (autopay_day BETWEEN 1 AND 31));
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS payment_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS payment_plan       TEXT NOT NULL DEFAULT 'actual' CHECK (payment_plan IN ('actual','average'));
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled'));
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS end_date           DATE;
