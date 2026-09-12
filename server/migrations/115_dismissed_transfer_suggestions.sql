-- Remembers transfer suggestions the user dismissed, so the periodic finder (which scans
-- already-posted transactions for transfer pairs — e.g. manually entered ones) doesn't
-- keep re-surfacing the same pair. Ordered pair (txn_a < txn_b). RLS mirrors migration 102.
CREATE TABLE IF NOT EXISTS dismissed_transfer_suggestions (
  id           SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  txn_a        INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  txn_b        INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, txn_a, txn_b)
);
CREATE INDEX IF NOT EXISTS idx_dismissed_transfer_suggestions_household ON dismissed_transfer_suggestions(household_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE dismissed_transfer_suggestions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE dismissed_transfer_suggestions FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS dismissed_transfer_suggestions_tenant_isolation ON dismissed_transfer_suggestions';
  EXECUTE 'CREATE POLICY dismissed_transfer_suggestions_tenant_isolation ON dismissed_transfer_suggestions
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
