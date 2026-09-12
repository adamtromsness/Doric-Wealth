-- Partial payments: an invoice can be settled by one or more payments, each
-- optionally tied to a transaction. The invoice's `paid` flag becomes derived —
-- true once the payments cover the line total. `auto_txn` marks payments whose
-- transaction was created by the "mark paid" convenience flow (so "unpay" can
-- remove those without touching a real, user-entered transaction).
CREATE TABLE IF NOT EXISTS utility_invoice_payments (
  id             SERIAL PRIMARY KEY,
  invoice_id     INTEGER NOT NULL REFERENCES utility_invoices(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  amount         NUMERIC(16,2) NOT NULL,
  paid_date      DATE,
  auto_txn       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_uip_invoice ON utility_invoice_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_uip_txn ON utility_invoice_payments(transaction_id);

-- Backfill existing paid invoices into a single full payment row (idempotent:
-- skipped once an invoice already has any payment recorded).
--
-- This migration originally predates household_id (added to tenant tables in 038
-- and backfilled in 039). On the first run the column doesn't exist yet, so the
-- insert omits it; on a RE-RUN the column exists as NOT NULL, so we must stamp it
-- from the parent invoice — otherwise re-running migrations after new paid
-- invoices exist (e.g. post-seed) would violate the not-null constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'utility_invoice_payments' AND column_name = 'household_id'
  ) THEN
    INSERT INTO utility_invoice_payments (invoice_id, transaction_id, amount, paid_date, auto_txn, household_id)
    SELECT i.id, i.transaction_id,
           COALESCE((SELECT SUM(amount) FROM utility_invoice_lines WHERE invoice_id = i.id), 0),
           i.paid_date, (i.transaction_id IS NOT NULL), i.household_id
    FROM utility_invoices i
    WHERE i.paid = true
      AND NOT EXISTS (SELECT 1 FROM utility_invoice_payments p WHERE p.invoice_id = i.id);
  ELSE
    INSERT INTO utility_invoice_payments (invoice_id, transaction_id, amount, paid_date, auto_txn)
    SELECT i.id, i.transaction_id,
           COALESCE((SELECT SUM(amount) FROM utility_invoice_lines WHERE invoice_id = i.id), 0),
           i.paid_date, (i.transaction_id IS NOT NULL)
    FROM utility_invoices i
    WHERE i.paid = true
      AND NOT EXISTS (SELECT 1 FROM utility_invoice_payments p WHERE p.invoice_id = i.id);
  END IF;
END $$;
