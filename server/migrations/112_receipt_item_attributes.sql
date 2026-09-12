-- Richer structured attributes on receipt line items, so AI/analytics can work at the
-- individual-product level: brand, package size + unit, a derived price-per-unit, and a
-- controlled top-level category (the existing free-text product_category stays as a
-- finer descriptor). Additive & idempotent.
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS brand     TEXT;
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS size      NUMERIC(12,3);   -- numeric package size, e.g. 32
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS unit      TEXT;            -- measure for `size`, e.g. oz, fl oz, lb, ct, gal, ea
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS uom_price NUMERIC(16,4);   -- price per single unit-of-measure (total_price / (quantity*size))
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS category  TEXT;            -- controlled taxonomy value (see ITEM_CATEGORIES)
CREATE INDEX IF NOT EXISTS idx_receipt_items_category ON receipt_items(household_id, category);
