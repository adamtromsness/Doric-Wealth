-- Free-text details for a tag (e.g. what a vacation was for, who went, dates).
-- Idempotent.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS description TEXT;
