-- Per-household Anthropic API key + model, settable from the UI so a household can
-- enable AI analysis without an env var. Falls back to the server's ANTHROPIC_API_KEY
-- when unset. Additive & idempotent.
ALTER TABLE households ADD COLUMN IF NOT EXISTS ai_api_key TEXT;
ALTER TABLE households ADD COLUMN IF NOT EXISTS ai_model   TEXT;
