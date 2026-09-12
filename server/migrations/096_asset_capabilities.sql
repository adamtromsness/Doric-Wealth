-- Capability tabs for generic assets (RV, airplane, boat, equipment, …): opt-in
-- Value snapshots, Maintenance, Insurance, and Documents — mirroring the vehicle/
-- property tracking, plus reusing the shared insurance_policies table. Additive & idempotent.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS tracks_value    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS has_maintenance BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS has_insurance   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS has_documents   BOOLEAN NOT NULL DEFAULT false;

-- Allow insurance policies to attach to an asset too.
ALTER TABLE insurance_policies DROP CONSTRAINT IF EXISTS insurance_policies_entity_kind_check;
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_entity_kind_check
  CHECK (entity_kind IN ('vehicle','property','asset'));

-- Value snapshots over time (latest drives the asset's current value).
CREATE TABLE IF NOT EXISTS asset_values (
  id           SERIAL PRIMARY KEY,
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  as_of        DATE NOT NULL,
  value        NUMERIC(16,2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_asset_values_asset ON asset_values(asset_id);

-- Maintenance / service log (completed history + upcoming items).
CREATE TABLE IF NOT EXISTS asset_maintenance (
  id             SERIAL PRIMARY KEY,
  asset_id       INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'completed',  -- completed | upcoming
  service_date   DATE,
  cost           NUMERIC(16,2),
  transaction_id INTEGER,
  due_date       DATE,
  vendor         TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_maintenance_asset ON asset_maintenance(asset_id);

-- Documents attached to an asset.
CREATE TABLE IF NOT EXISTS asset_documents (
  id           SERIAL PRIMARY KEY,
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL DEFAULT 'other',
  name         TEXT,
  file         BYTEA,
  file_mime    TEXT,
  file_name    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_documents_asset ON asset_documents(asset_id);

DO $$
DECLARE tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['asset_values','asset_maintenance','asset_documents']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_isolation', tbl);
    EXECUTE format('CREATE POLICY %I ON %I USING (household_id = current_setting(''app.household_id'', true)::int) WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)', tbl || '_tenant_isolation', tbl);
  END LOOP;
END $$;
