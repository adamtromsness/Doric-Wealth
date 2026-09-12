-- Utilities redesign: accounts -> invoices -> per-utility lines.
-- An invoice can cover several accounts (e.g. water + trash on one city bill),
-- with each utility tracked separately as its own line.

CREATE TABLE IF NOT EXISTS utility_accounts (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  provider       TEXT,
  utility_type   TEXT NOT NULL DEFAULT 'electricity'
                 CHECK (utility_type IN ('electricity','gas','water','sewer','trash','internet','phone','other')),
  account_number TEXT,
  property_id    INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  due_day        INTEGER CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
  usage_unit     TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_util_accounts_property ON utility_accounts(property_id);

CREATE TABLE IF NOT EXISTS utility_invoices (
  id             SERIAL PRIMARY KEY,
  provider       TEXT,
  invoice_date   DATE,
  period_start   DATE,
  period_end     DATE,
  due_date       DATE,
  paid           BOOLEAN NOT NULL DEFAULT FALSE,
  paid_date      DATE,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_util_invoices_due ON utility_invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_util_invoices_paid ON utility_invoices(paid);

CREATE TABLE IF NOT EXISTS utility_invoice_lines (
  id                 SERIAL PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES utility_invoices(id) ON DELETE CASCADE,
  utility_account_id INTEGER REFERENCES utility_accounts(id) ON DELETE SET NULL,
  amount             NUMERIC(16,2) NOT NULL,
  usage_quantity     NUMERIC(16,3),
  usage_unit         TEXT,
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_util_lines_invoice ON utility_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_util_lines_account ON utility_invoice_lines(utility_account_id);

-- One-time migration of legacy utility_bills into the new model (only when the
-- new accounts table is still empty). Each bill becomes one account (created
-- lazily per provider+type) + one invoice + one line. Legacy table is kept.
DO $$
DECLARE b RECORD; acct_id INTEGER; inv_id INTEGER;
BEGIN
  IF (SELECT count(*) FROM utility_accounts) = 0
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'utility_bills')
     AND (SELECT count(*) FROM utility_bills) > 0 THEN
    FOR b IN SELECT * FROM utility_bills LOOP
      SELECT id INTO acct_id FROM utility_accounts
        WHERE provider IS NOT DISTINCT FROM b.provider AND utility_type = b.utility_type LIMIT 1;
      IF acct_id IS NULL THEN
        INSERT INTO utility_accounts (name, provider, utility_type, usage_unit)
        VALUES (COALESCE(b.provider, 'Utility'), b.provider, b.utility_type, b.usage_unit)
        RETURNING id INTO acct_id;
      END IF;
      INSERT INTO utility_invoices (provider, invoice_date, period_start, period_end, due_date, paid, transaction_id, notes)
      VALUES (b.provider, COALESCE(b.period_end, b.due_date), b.period_start, b.period_end, b.due_date, b.paid, b.transaction_id, b.notes)
      RETURNING id INTO inv_id;
      INSERT INTO utility_invoice_lines (invoice_id, utility_account_id, amount, usage_quantity, usage_unit)
      VALUES (inv_id, acct_id, b.amount, b.usage_quantity, b.usage_unit);
    END LOOP;
  END IF;
END $$;
