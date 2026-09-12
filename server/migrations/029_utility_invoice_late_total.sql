-- Some bills show a higher "if paid after the due date" amount (late fee). The
-- line breakdown sums to the on-time total; this stores the late-payment total,
-- used for the outstanding figure once an invoice is overdue.
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS late_total NUMERIC(16,2);
