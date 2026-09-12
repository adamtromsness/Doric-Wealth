-- Account portal login details for a subscription (where to manage / cancel it).
-- Additive & idempotent; mirrors the utility account login columns (083).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS login_url TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS login_id  TEXT;
