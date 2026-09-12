-- Track when a previously-seen external account stops appearing in the SimpleFIN
-- response (e.g. its institution lapsed into "needs re-auth" and silently dropped out).
-- missing_since IS NULL means currently returned by the API; non-null = the time it went
-- missing, so the UI can flag it to re-check at bridge.simplefin.org. Additive & idempotent.
ALTER TABLE account_links ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;
