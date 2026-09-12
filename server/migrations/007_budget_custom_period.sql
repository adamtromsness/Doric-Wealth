-- Budgets can target a fixed custom date range (period = 'custom'), not just a
-- recurring weekly/monthly/yearly window. end_date is only used for custom budgets.
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_period_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_period_check
  CHECK (period IN ('weekly','monthly','yearly','custom'));
