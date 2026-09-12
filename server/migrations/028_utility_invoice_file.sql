-- Store the original uploaded invoice file (PDF/image) for review, plus its
-- type and original name. The AI vision pass reads it to pre-fill the form.
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS file BYTEA;
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS file_mime TEXT;
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS file_name TEXT;
