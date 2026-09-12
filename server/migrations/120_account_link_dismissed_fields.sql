-- Per-field dismissals for "update from SimpleFIN" suggestions: a map of field →
-- dismissed proposed value (e.g. {"name":"Premier Checking"}). A field suggestion stays
-- hidden until SimpleFIN reports a different value for that field. Replaces the single
-- dismissed_suggestion signature. Additive & idempotent.
ALTER TABLE account_links ADD COLUMN IF NOT EXISTS dismissed_fields JSONB NOT NULL DEFAULT '{}';
