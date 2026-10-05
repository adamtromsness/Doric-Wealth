-- Reconciliation integrity, continued (see 129). A transfer into a loan counts only
-- its principal, and with a split breakdown that's the sum of the lines flagged
-- is_principal, so editing the splits of a reconciled transfer could change what a
-- completed reconciliation cleared without touching the transaction row that 129
-- guards. The account's liability flag and opening balance feed the same balances.
-- Additive and idempotent.

-- Splits: checked at commit (deferred), because saving splits deletes and reinserts
-- them; only the end result matters. Refuses a change that leaves a cleared item's
-- effect on its completed reconciliation different from what was frozen. Category,
-- notes, and tag edits (same amounts and principal flags) pass.
CREATE OR REPLACE FUNCTION guard_reconciled_splits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  txn_ids INTEGER[];
BEGIN
  txn_ids := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.transaction_id]
    WHEN 'DELETE' THEN ARRAY[OLD.transaction_id]
    ELSE ARRAY[OLD.transaction_id, NEW.transaction_id] END;
  -- Wait for a reconciliation being completed with these transactions (it locks
  -- them), so the check below sees whether it completed.
  PERFORM 1 FROM transactions WHERE id = ANY(txn_ids) FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1
      FROM reconciliation_items ri
      JOIN reconciliation_sessions s ON s.id = ri.session_id
      JOIN transactions t ON t.id = ri.transaction_id AND t.book_id = ri.book_id
     WHERE ri.transaction_id = ANY(txn_ids) AND ri.cleared AND s.status = 'completed'
       AND ri.frozen_delta IS NOT NULL
       AND t.account_id IS DISTINCT FROM s.account_id
       AND ri.frozen_delta IS DISTINCT FROM (
         CASE
           WHEN EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id AND sp.book_id = t.book_id)
             THEN COALESCE((SELECT SUM(sp.amount) FROM transaction_splits sp WHERE sp.transaction_id = t.id AND sp.book_id = t.book_id AND sp.is_principal), 0)
           ELSE COALESCE(t.principal_amount, t.amount)
         END)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DR409',
      MESSAGE = 'This transfer is part of a completed reconciliation. Reopen that reconciliation before changing how much of it is principal.';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS transaction_splits_guard_reconciled ON transaction_splits;
CREATE CONSTRAINT TRIGGER transaction_splits_guard_reconciled
  AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_reconciled_splits();

-- Accounts: the liability flag flips the sign of every balance, and the opening
-- balance anchors one, so neither changes while the account has a completed
-- reconciliation. Other fields (name, institution, …) stay editable.
CREATE OR REPLACE FUNCTION guard_reconciled_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_liability IS NOT DISTINCT FROM OLD.is_liability
     AND NEW.opening_balance IS NOT DISTINCT FROM OLD.opening_balance THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM reconciliation_sessions s
     WHERE s.account_id = OLD.id AND s.book_id = OLD.book_id AND s.status = 'completed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DR409',
      MESSAGE = 'This account has a completed reconciliation. Reopen it before changing whether the account is a liability or its opening balance.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS accounts_guard_reconciled ON accounts;
CREATE TRIGGER accounts_guard_reconciled
  BEFORE UPDATE OF is_liability, opening_balance ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_reconciled_account();
