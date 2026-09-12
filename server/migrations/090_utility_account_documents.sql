-- Account-level documents for a utility account (statements, agreements, letters, …),
-- mirroring account_documents. Distinct from per-invoice file attachments. Additive & idempotent.
CREATE TABLE IF NOT EXISTS utility_account_documents (
  id                 SERIAL PRIMARY KEY,
  utility_account_id INTEGER NOT NULL REFERENCES utility_accounts(id) ON DELETE CASCADE,
  household_id       INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  doc_type           TEXT NOT NULL DEFAULT 'other',
  name               TEXT,
  file               BYTEA,
  file_mime          TEXT,
  file_name          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utility_account_documents_household ON utility_account_documents(household_id);
CREATE INDEX IF NOT EXISTS idx_utility_account_documents_account ON utility_account_documents(utility_account_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE utility_account_documents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE utility_account_documents FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS utility_account_documents_tenant_isolation ON utility_account_documents';
  EXECUTE 'CREATE POLICY utility_account_documents_tenant_isolation ON utility_account_documents
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
