-- When two imported provider lines are merged into ONE transaction (the two sides of a
-- transfer — e.g. a credit-card payment that arrives as a debit on checking and a credit
-- on the card), the absorbed line's provider id must still suppress future re-import.
-- A transaction row has only one external_id, so the second consumed id is recorded here
-- and checked by the SimpleFIN dedup. Additive & idempotent; RLS mirrors migration 102.
CREATE TABLE IF NOT EXISTS consumed_external_ids (
  id             SERIAL PRIMARY KEY,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  source         TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumed_external_ids ON consumed_external_ids(household_id, source, external_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE consumed_external_ids ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE consumed_external_ids FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS consumed_external_ids_tenant_isolation ON consumed_external_ids';
  EXECUTE 'CREATE POLICY consumed_external_ids_tenant_isolation ON consumed_external_ids
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
