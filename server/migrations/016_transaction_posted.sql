-- Pending vs posted: a transaction is "pending" until it has a posted_date.
-- Guarded so the one-time backfill (mark all existing rows posted) only runs when
-- the column is first added — re-running migrate must never clobber pending rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transactions' AND column_name = 'posted_date'
  ) THEN
    ALTER TABLE transactions ADD COLUMN posted_date DATE;
    UPDATE transactions SET posted_date = txn_date;  -- existing rows are already posted
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_txn_posted ON transactions(posted_date);
