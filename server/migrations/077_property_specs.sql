-- More property specifications (bedrooms, bathrooms, stories, garage). Additive & idempotent.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS bedrooms INTEGER,
  ADD COLUMN IF NOT EXISTS bathrooms NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS stories INTEGER,
  ADD COLUMN IF NOT EXISTS garage_spaces INTEGER;
