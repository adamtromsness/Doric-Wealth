-- Transfers: a transaction can move money between two accounts.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_direction_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_direction_check
  CHECK (direction IN ('expense','income','transfer'));

-- Computed balances: each account has an opening balance as-of a date; the
-- posted/pending balance = opening + the signed sum of its transactions.
-- One-time backfill (guarded): set opening so each account's current computed
-- balance equals its latest recorded snapshot, then snapshots become optional.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='opening_balance') THEN
    ALTER TABLE accounts ADD COLUMN opening_balance NUMERIC(16,2) NOT NULL DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN opening_date DATE;
    UPDATE accounts a SET
      opening_date = CURRENT_DATE,
      opening_balance = COALESCE((SELECT balance FROM account_balances WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1), 0)
        - (CASE WHEN a.is_liability THEN -1 ELSE 1 END) * COALESCE((
            SELECT SUM(CASE WHEN direction = 'income' THEN amount WHEN direction = 'expense' THEN -amount ELSE 0 END)
            FROM transactions WHERE account_id = a.id), 0);
  END IF;
END $$;
