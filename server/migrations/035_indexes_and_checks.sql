-- Indexes for account-scoped lookups (budget account scoping, balance math) and
-- frequently-filtered foreign keys.
CREATE INDEX IF NOT EXISTS idx_txn_account          ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_transfer_account ON transactions(transfer_account_id);
CREATE INDEX IF NOT EXISTS idx_sub_category         ON subscriptions(category_id);
CREATE INDEX IF NOT EXISTS idx_sub_account          ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_uinv_transaction     ON utility_invoices(transaction_id);
CREATE INDEX IF NOT EXISTS idx_uinv_account         ON utility_invoices(account_id);

-- Constrain budget_lines.rollover_mode to its known values (it stored free text).
ALTER TABLE budget_lines DROP CONSTRAINT IF EXISTS budget_lines_rollover_mode_chk;
ALTER TABLE budget_lines ADD  CONSTRAINT budget_lines_rollover_mode_chk
  CHECK (rollover_mode IN ('reset', 'carryover', 'accrue'));
