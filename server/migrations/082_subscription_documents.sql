-- Documents attached to a subscription (invoices, receipts, contracts, …), mirroring
-- property_documents. Carries a doc_type category from the start. Additive & idempotent.
CREATE TABLE IF NOT EXISTS subscription_documents (
  id              SERIAL PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL DEFAULT 'other',
  name            TEXT,
  file            BYTEA,
  file_mime       TEXT,
  file_name       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_documents_household ON subscription_documents(household_id);
CREATE INDEX IF NOT EXISTS idx_subscription_documents_subscription ON subscription_documents(subscription_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE subscription_documents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE subscription_documents FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS subscription_documents_tenant_isolation ON subscription_documents';
  EXECUTE 'CREATE POLICY subscription_documents_tenant_isolation ON subscription_documents
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
