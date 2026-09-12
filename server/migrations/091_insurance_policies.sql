-- Insurance policies attached to a vehicle or property (carrier, policy #, premium,
-- term/renewal, agent contact). Polymorphic owner so one table + one UI serves both.
-- Additive & idempotent.
CREATE TABLE IF NOT EXISTS insurance_policies (
  id             SERIAL PRIMARY KEY,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  entity_kind    TEXT NOT NULL CHECK (entity_kind IN ('vehicle','property')),
  entity_id      INTEGER NOT NULL,
  policy_type    TEXT,                       -- auto, home, flood, umbrella, …
  carrier        TEXT,
  policy_number  TEXT,
  premium        NUMERIC(16,2),
  premium_cycle  TEXT NOT NULL DEFAULT 'monthly' CHECK (premium_cycle IN ('monthly','quarterly','semiannual','annual')),
  coverage       TEXT,
  deductible     NUMERIC(16,2),
  agent_name     TEXT,
  agent_phone    TEXT,
  start_date     DATE,
  renewal_date   DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_household ON insurance_policies(household_id);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_owner ON insurance_policies(entity_kind, entity_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE insurance_policies ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE insurance_policies FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS insurance_policies_tenant_isolation ON insurance_policies';
  EXECUTE 'CREATE POLICY insurance_policies_tenant_isolation ON insurance_policies
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
