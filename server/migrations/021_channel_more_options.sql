-- Broaden the purchase channel beyond online/in-store to cover how else a
-- transaction was conducted: by phone, by mail, or by check. NULL = unspecified.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_channel_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_channel_check
  CHECK (channel IN ('in_store','online','phone','mail','check'));
