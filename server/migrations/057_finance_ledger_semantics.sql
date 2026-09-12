-- Finance-model improvements (scoped, additive, idempotent, household-scoped):
--   1. Budget period snapshots so historical plan-vs-actual is frozen.
--   2. Category archival (archive instead of losing the name on delete).
--   3. Explicit transfer linkage (transfer_group_id) for reconciliation/import.
--   4. A true dated balance-event ledger for net-worth history.
-- Existing data stays readable; existing columns/behaviour are untouched.

-- ===== 1. Budget period snapshots ==========================================
CREATE TABLE IF NOT EXISTS budget_periods (
  id           SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  budget_id    INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (budget_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_budget_periods_household ON budget_periods(household_id);
CREATE INDEX IF NOT EXISTS idx_budget_periods_budget ON budget_periods(budget_id);

-- Frozen copy of each planned line for a period (label/kind snapshotted so the
-- report survives a later category rename/archive/delete).
CREATE TABLE IF NOT EXISTS budget_period_lines (
  id              SERIAL PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  period_id       INTEGER NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_name   TEXT,
  category_kind   TEXT,
  planned_amount  NUMERIC(16,2) NOT NULL DEFAULT 0,
  rollover_mode   TEXT,
  opening_balance NUMERIC(16,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_period_lines_household ON budget_period_lines(household_id);
CREATE INDEX IF NOT EXISTS idx_budget_period_lines_period ON budget_period_lines(period_id);

-- ===== 2. Category archival ================================================
ALTER TABLE categories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ===== 3. Explicit transfer linkage ========================================
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_transfer_group ON transactions(transfer_group_id) WHERE transfer_group_id IS NOT NULL;
-- Give every existing transfer a stable group id (idempotent: only fills NULLs).
UPDATE transactions SET transfer_group_id = 'txn-' || id
 WHERE direction = 'transfer' AND transfer_group_id IS NULL;

-- ===== 4. Account balance-event ledger =====================================
CREATE TABLE IF NOT EXISTS account_balance_events (
  id                 SERIAL PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of              DATE NOT NULL,
  balance            NUMERIC(16,2) NOT NULL,
  event_type         TEXT NOT NULL DEFAULT 'snapshot' CHECK (event_type IN ('snapshot','adjustment','revaluation','import','opening')),
  source             TEXT,
  note               TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_balance_events_household ON account_balance_events(household_id);
CREATE INDEX IF NOT EXISTS idx_balance_events_account ON account_balance_events(account_id, as_of);

-- Backfill the ledger from existing dated snapshots (idempotent: guarded so a
-- re-run doesn't duplicate the backfilled rows).
INSERT INTO account_balance_events (household_id, account_id, as_of, balance, event_type, source, created_at)
SELECT ab.household_id, ab.account_id, ab.as_of, ab.balance, 'snapshot', 'backfill', ab.created_at
FROM account_balances ab
WHERE ab.household_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM account_balance_events e
    WHERE e.account_id = ab.account_id AND e.as_of = ab.as_of AND e.source = 'backfill'
  );

-- Row-level security for the new tenant tables (matches migration 042/049/056).
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY['budget_periods','budget_period_lines','account_balance_events'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (household_id = current_setting(''app.household_id'', true)::int)
         WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
