-- A manual starting balance for carryover/accrue budget lines: the balance the
-- category began with at the budget's start (added on top of the computed
-- period-to-period carry). Ignored for 'reset' lines.
ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(16,2) NOT NULL DEFAULT 0;
