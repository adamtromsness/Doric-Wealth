-- Documents attached to a bank account (statements, tax forms, agreements, …),
-- mirroring subscription_documents. Carries a doc_type category. Additive & idempotent.
CREATE TABLE IF NOT EXISTS account_documents (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL DEFAULT 'other',
  name          TEXT,
  file          BYTEA,
  file_mime     TEXT,
  file_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_documents_household ON account_documents(household_id);
CREATE INDEX IF NOT EXISTS idx_account_documents_account ON account_documents(account_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE account_documents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE account_documents FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS account_documents_tenant_isolation ON account_documents';
  EXECUTE 'CREATE POLICY account_documents_tenant_isolation ON account_documents
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
