-- The "Set up" tier of the To-Do list is computed from current state, but a user
-- can dismiss optional setup items they don't care about (e.g. "add a property").
-- We persist just the dismissed keys per household; everything else is derived live.
-- Additive & idempotent.
ALTER TABLE households ADD COLUMN IF NOT EXISTS dismissed_setup_tasks JSONB NOT NULL DEFAULT '[]'::jsonb;
