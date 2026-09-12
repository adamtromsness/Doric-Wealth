-- Free-form notes for a vehicle (mirrors property notes). Additive & idempotent.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS notes TEXT;
