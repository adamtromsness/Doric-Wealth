-- More practical utility-account metadata: autopay + payment method, meter/service
-- number, provider support phone, account holder, and rate plan. Additive & idempotent.
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS is_autopay     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS meter_number   TEXT;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS provider_phone TEXT;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS account_holder TEXT;
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS rate_plan      TEXT;
