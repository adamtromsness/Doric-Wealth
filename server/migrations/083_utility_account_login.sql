-- Provider portal login details for a utility account (where to pay / view bills).
-- Additive & idempotent.
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS login_url TEXT;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS login_id  TEXT;
