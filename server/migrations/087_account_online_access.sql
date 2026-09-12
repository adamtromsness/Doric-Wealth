-- Online-access contact fields for a bank account, mirroring the utility
-- "Provider & Access" section (website + phone alongside the existing
-- login_url + username). Additive & idempotent.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone       TEXT;
