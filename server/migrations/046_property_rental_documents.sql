-- Properties: rental details, legal description, and attached documents/images.
-- Idempotent.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_rental        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_occupied      BOOLEAN;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tenant_name      TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lease_start      DATE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lease_end        DATE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS security_deposit NUMERIC(16,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS legal_description TEXT;

-- Documents/images attached to a property (deed, survey, photos, …). Bytes stored
-- inline like receipts; not loaded with the property list.
CREATE TABLE IF NOT EXISTS property_documents (
  id           SERIAL PRIMARY KEY,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT,
  file         BYTEA,
  file_mime    TEXT,
  file_name    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_documents_household ON property_documents(household_id);
CREATE INDEX IF NOT EXISTS idx_property_documents_property ON property_documents(property_id);

-- Row-level security (defense-in-depth), matching migration 042's pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE property_documents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE property_documents FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS property_documents_tenant_isolation ON property_documents';
  EXECUTE 'CREATE POLICY property_documents_tenant_isolation ON property_documents
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
