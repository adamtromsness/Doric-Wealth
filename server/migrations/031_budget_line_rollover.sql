-- Per-budget-line behavior across periods:
--   reset     – fresh allocation each period (default)
--   carryover – unspent funds roll forward (overspend is forgiven, floored at 0)
--   accrue    – running balance / sinking fund (overspend draws the balance down)
ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS rollover_mode TEXT NOT NULL DEFAULT 'reset';
