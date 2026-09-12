-- Allow neutralizing a balance-ledger fact without breaking the append-only ledger.
-- When a manual balance snapshot (account_balances row) is deleted, the matching
-- snapshot event in account_balance_events is marked voided rather than removed, so
-- net-worth history stops counting it while the ledger keeps its historical record.
ALTER TABLE account_balance_events ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- Net-worth history scans live (non-voided) events per account in date order.
CREATE INDEX IF NOT EXISTS idx_balance_events_live
  ON account_balance_events(account_id, as_of)
  WHERE voided_at IS NULL;
