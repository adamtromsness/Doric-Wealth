-- Date of birth on the user profile (optional). Additive & idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE;
