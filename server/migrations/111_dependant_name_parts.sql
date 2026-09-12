-- Dependants get first/middle/last name parts (the existing `name` stays as the
-- derived display value). Additive & idempotent.
ALTER TABLE user_dependants ADD COLUMN IF NOT EXISTS first_name  TEXT;
ALTER TABLE user_dependants ADD COLUMN IF NOT EXISTS middle_name TEXT;
ALTER TABLE user_dependants ADD COLUMN IF NOT EXISTS last_name   TEXT;
