-- Mark a property as new construction (built, not purchased). When set, the
-- purchase price/date are treated as the construction cost/completion date.
-- Additive & idempotent.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_new_construction BOOLEAN NOT NULL DEFAULT false;
