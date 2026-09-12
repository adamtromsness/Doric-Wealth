-- User-created tags (labels) that can be applied to transactions, e.g. a
-- specific trip ("Hawaii 2026"), so charges can be grouped for reporting.
-- These join to transactions via line_tags with kind = 'tag' and ref_id = tags.id
-- (line_tags.ref_id is generic, so no change to that table is needed). Idempotent.
CREATE TABLE IF NOT EXISTS tags (
  id           SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  archived     BOOLEAN NOT NULL DEFAULT false,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tags_household ON tags(household_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_household_name ON tags(household_id, lower(name));

-- Allow line_tags to reference a user tag (migration 019 only permitted
-- vehicle/property/subscription). Idempotent: drop then re-add the check.
ALTER TABLE line_tags DROP CONSTRAINT IF EXISTS line_tags_kind_check;
ALTER TABLE line_tags ADD CONSTRAINT line_tags_kind_check CHECK (kind IN ('vehicle','property','subscription','tag'));

-- Row-level security (defense-in-depth), matching migration 047's pattern.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE tags ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE tags FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tags_tenant_isolation ON tags';
  EXECUTE 'CREATE POLICY tags_tenant_isolation ON tags
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
