-- Structured name fields for a user's profile, plus a last-login timestamp shown
-- on the household members list. All additive + idempotent (safe to re-run).
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS middle_name    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMPTZ;
