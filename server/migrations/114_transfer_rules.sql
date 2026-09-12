-- Remembered account pairs that auto-link on import: when an imported expense in
-- source_account_id matches an imported income in dest_account_id (equal amount, a few
-- days apart), it's merged into a transfer without prompting. Directional. RLS mirrors 102.
CREATE TABLE IF NOT EXISTS transfer_rules (
  id                SERIAL PRIMARY KEY,
  household_id      INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dest_account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, source_account_id, dest_account_id)
);
CREATE INDEX IF NOT EXISTS idx_transfer_rules_household ON transfer_rules(household_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE transfer_rules ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE transfer_rules FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS transfer_rules_tenant_isolation ON transfer_rules';
  EXECUTE 'CREATE POLICY transfer_rules_tenant_isolation ON transfer_rules
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
