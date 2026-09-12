-- Capability-driven account detail: a universal owner, opt-in capability flags
-- (each reveals a dedicated detail tab, like a property's is_rental), and the
-- type-specific fields those tabs hold. Additive & idempotent.

-- Universal owner (critical for retirement/custodial accounts).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner          TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner_user_id  INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ownership_type TEXT;   -- individual | joint | custodial | trust

-- Capability flags (opt-in; type seeds sensible defaults in the UI).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS has_beneficiaries BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_retirement     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_card           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_loan           BOOLEAN NOT NULL DEFAULT false;

-- Retirement tab.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_plan_kind        TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_custodian        TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_employer         TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_contribution_ytd NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_employer_match   TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_vesting_pct      NUMERIC(6,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_tax_treatment    TEXT;   -- pretax | roth | after_tax
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS retirement_rmd_applicable   BOOLEAN;

-- Card tab (credit_limit, interest_rate already exist).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_statement_day   INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_min_payment     NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_rewards_program TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_points_balance  NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_annual_fee      NUMERIC(16,2);

-- Loan tab (interest_rate, due_day already exist).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_original_principal NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_term_months        INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_payment_amount     NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_payment_frequency  TEXT;   -- monthly | biweekly | weekly
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_origination_date   DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_payoff_date        DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_escrow_amount      NUMERIC(16,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS loan_lien_holder        TEXT;
