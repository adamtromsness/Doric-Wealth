-- Utility companies bill on different schedules (monthly, quarterly, yearly).
ALTER TABLE utility_accounts ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly'
  CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly'));
