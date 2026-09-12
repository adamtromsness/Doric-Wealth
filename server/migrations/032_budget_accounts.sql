-- Optional account scoping for a budget. When a budget has rows here, only
-- transactions from those accounts count toward its actuals; with no rows, all
-- accounts are considered.
CREATE TABLE IF NOT EXISTS budget_accounts (
  budget_id  INTEGER NOT NULL REFERENCES budgets(id)  ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (budget_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_budget_accounts_budget ON budget_accounts(budget_id);
