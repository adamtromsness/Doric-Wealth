-- Warranties can carry a cost. That cost is either bundled into the vehicle's
-- purchase price (cost_in_purchase_price) or paid separately — in which case it can
-- be linked to the transaction that paid for it. All additive & idempotent.
ALTER TABLE vehicle_warranties ADD COLUMN IF NOT EXISTS cost NUMERIC(16,2);
ALTER TABLE vehicle_warranties ADD COLUMN IF NOT EXISTS cost_in_purchase_price BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vehicle_warranties ADD COLUMN IF NOT EXISTS transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;
