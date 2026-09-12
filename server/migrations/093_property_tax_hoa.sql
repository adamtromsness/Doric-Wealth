-- Recurring carrying costs for a property: annual property tax and HOA dues
-- (with a billing cycle). Additive & idempotent.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_tax_annual NUMERIC(16,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS hoa_dues            NUMERIC(16,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS hoa_cycle           TEXT;
