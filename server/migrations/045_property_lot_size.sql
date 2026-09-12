-- Lot / land size for a property, in acres.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_size_acres NUMERIC(12,3);
