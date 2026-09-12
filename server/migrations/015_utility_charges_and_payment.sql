-- Invoice lines get a free-text description so a bill can mix a usage-tracked
-- utility line (e.g. water: 4,200 gal) with other charges (sewer, base fee, tax).
ALTER TABLE utility_invoice_lines ADD COLUMN IF NOT EXISTS description TEXT;

-- Invoices can record a real expense transaction when paid, against a budget
-- category and the bank account they're paid from.
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS account_id  INTEGER REFERENCES accounts(id)   ON DELETE SET NULL;
