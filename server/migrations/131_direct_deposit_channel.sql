-- Add 'direct_deposit' (e.g. a paycheck deposited straight into an account) to the
-- channel options. transactions.channel and utility_invoices.channel share the same
-- list (a paid invoice's channel flows to its transaction). Idempotent.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_channel_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_channel_check
  CHECK (channel IN ('in_store','online','phone','mail','check','direct_deposit'));

ALTER TABLE utility_invoices DROP CONSTRAINT IF EXISTS utility_invoices_channel_check;
ALTER TABLE utility_invoices ADD CONSTRAINT utility_invoices_channel_check
  CHECK (channel IN ('in_store','online','phone','mail','check','direct_deposit'));
