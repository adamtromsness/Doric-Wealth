-- Richer personal profile: occupation, retirement planning, contact + emergency
-- details (all 1:1 on the user) and a dependants list (1:many). All optional.
-- Additive & idempotent. users is an identity table (no RLS); auth routes scope by user_id.

-- Contact
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state_region   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country        TEXT;

-- Occupation
ALTER TABLE users ADD COLUMN IF NOT EXISTS employer          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_status TEXT;   -- employed | self_employed | retired | unemployed | student | other
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS annual_income     NUMERIC(14,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_start  DATE;

-- Retirement
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_retirement_age  INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_retirement_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS desired_monthly_income NUMERIC(14,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_contribution   NUMERIC(14,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS retirement_notes       TEXT;

-- Emergency contact
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_name         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_relationship TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_phone        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_email        TEXT;

-- Dependants (children/others you support)
CREATE TABLE IF NOT EXISTS user_dependants (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  relationship TEXT,
  dob          DATE,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_dependants_user ON user_dependants(user_id);
