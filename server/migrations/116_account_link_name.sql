-- Persist the SimpleFIN-reported account NAME (e.g. "Premier Checking") on the link, so
-- a local account can be created/updated from it. Until now only org_name (the
-- institution) was stored. Additive & idempotent; populated on the next sync/refresh.
ALTER TABLE account_links ADD COLUMN IF NOT EXISTS name TEXT;
