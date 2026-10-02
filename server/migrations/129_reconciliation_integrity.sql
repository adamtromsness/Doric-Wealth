-- Reconciliation integrity. A completed reconciliation now means something: it is
-- only allowed when opening balance + cleared items = statement balance, it freezes
-- the evidence (each cleared item's amount and dates, and the cleared balance), and
-- the transactions it reconciled can't be changed or deleted until it is explicitly
-- reopened (recorded in reconciliation_events). Additive and idempotent.

ALTER TABLE reconciliation_sessions ADD COLUMN IF NOT EXISTS opening_balance      NUMERIC(16,2);
ALTER TABLE reconciliation_sessions ADD COLUMN IF NOT EXISTS cleared_balance      NUMERIC(16,2);
ALTER TABLE reconciliation_sessions ADD COLUMN IF NOT EXISTS completed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Frozen at completion: what was reconciled, independent of later edits elsewhere.
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS frozen_delta       NUMERIC(16,2);
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS frozen_amount      NUMERIC(16,2);
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS frozen_txn_date    DATE;
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS frozen_posted_date DATE;

-- Audit trail for session lifecycle changes (created, completed, reopened, canceled).
CREATE TABLE IF NOT EXISTS reconciliation_events (
  id         SERIAL PRIMARY KEY,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES reconciliation_sessions(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('created','completed','reopened','canceled')),
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recon_events_session ON reconciliation_events(session_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE reconciliation_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE reconciliation_events FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS reconciliation_events_tenant_isolation ON reconciliation_events';
  EXECUTE 'CREATE POLICY reconciliation_events_tenant_isolation ON reconciliation_events
             USING (book_id = current_setting(''app.book_id'', true)::int)
             WITH CHECK (book_id = current_setting(''app.book_id'', true)::int)';
END $$;

-- Guard reconciled transactions at the database, so every path (edit, bulk edit,
-- transfer conversion, purge, …) is covered. Refuses changing the amount, dates,
-- direction, accounts, or principal of, or deleting, a transaction cleared in a
-- completed reconciliation. Merchant, category, notes, etc. stay editable. Deletes
-- cascading from removing a whole account or book (trigger depth > 1) are allowed.
-- SQLSTATE DR409 is mapped to HTTP 409 by the API's error handler.
CREATE OR REPLACE FUNCTION guard_reconciled_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.amount              IS NOT DISTINCT FROM OLD.amount
     AND NEW.txn_date            IS NOT DISTINCT FROM OLD.txn_date
     AND NEW.posted_date         IS NOT DISTINCT FROM OLD.posted_date
     AND NEW.direction           IS NOT DISTINCT FROM OLD.direction
     AND NEW.account_id          IS NOT DISTINCT FROM OLD.account_id
     AND NEW.transfer_account_id IS NOT DISTINCT FROM OLD.transfer_account_id
     AND NEW.principal_amount    IS NOT DISTINCT FROM OLD.principal_amount THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM reconciliation_items ri
      JOIN reconciliation_sessions s ON s.id = ri.session_id
     WHERE ri.transaction_id = OLD.id AND ri.cleared AND s.status = 'completed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DR409',
      MESSAGE = 'This transaction is part of a completed reconciliation. Reopen that reconciliation before changing its amount, dates, or accounts, or deleting it.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS transactions_guard_reconciled ON transactions;
CREATE TRIGGER transactions_guard_reconciled
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION guard_reconciled_transaction();
