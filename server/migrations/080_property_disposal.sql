-- Let a property be marked "no longer owned" (sold, transferred, …) while keeping
-- its history. A NULL disposed_at = still owned. Additive & idempotent; mirrors the
-- vehicle disposal columns (060).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS disposed_at             DATE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS disposal_type           TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS disposal_amount         NUMERIC(16,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS disposal_note           TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS disposal_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;
