-- Loan-payment transfers can carry a principal/interest split: a payment is one
-- transfer (full amount leaves the source account), but only `principal_amount`
-- pays down the destination liability — the remainder (amount - principal_amount)
-- is interest, which surfaces as an expense (optionally under interest_category_id)
-- in budgets/analysis. NULL principal_amount = an ordinary transfer (unchanged).
-- Idempotent.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS principal_amount NUMERIC(16,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS interest_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;

-- principal_amount only makes sense on a transfer, and must be within [0, amount].
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_principal_amount_chk;
ALTER TABLE transactions ADD CONSTRAINT transactions_principal_amount_chk CHECK (
  principal_amount IS NULL
  OR (direction = 'transfer' AND principal_amount >= 0 AND principal_amount <= amount)
);
