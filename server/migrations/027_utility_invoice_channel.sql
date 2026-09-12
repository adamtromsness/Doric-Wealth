-- How a utility invoice was paid (online, check, …); flows to the transaction.
ALTER TABLE utility_invoices ADD COLUMN IF NOT EXISTS channel TEXT
  CHECK (channel IN ('in_store', 'online', 'phone', 'mail', 'check'));
