-- Richer per-account detail. All optional; relevance varies by account type
-- (e.g. interest_rate for savings/checking, credit_limit + due_day + username
-- for credit cards, beneficiaries for HSA/retirement, ...).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_number  TEXT;        -- full or last-4
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS interest_rate   NUMERIC(6,3); -- APR / APY %
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_limit    NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS due_day         INTEGER       -- day of month a payment is due
                CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS username        TEXT;        -- online-login username
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS beneficiaries   TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opened_date     DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS notes           TEXT;
