-- Categorize a subscription by what kind of service it is (software, streaming,
-- music, …). Free text from a frontend-provided list; NULL = unspecified.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS service_type TEXT;
