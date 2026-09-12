-- Scheduled, server-generated data backups. The user picks a cadence (daily/weekly)
-- and a start anchor; a background job produces a full-household snapshot on schedule
-- and stores it here, downloadable from the My Data page (a scheduled backup can't push
-- a file to the browser, so it's kept server-side until the user retrieves it).
-- Additive & idempotent; RLS mirrors migration 102.

-- One settings row per household. enabled gates the background job; frequency controls
-- cadence; start_at anchors the time-of-day (mirrors the SimpleFIN auto-import schedule).
CREATE TABLE IF NOT EXISTS household_backup_settings (
  household_id   INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  frequency      TEXT NOT NULL DEFAULT 'weekly',   -- daily | weekly
  start_at       TIMESTAMPTZ,
  retain         INTEGER NOT NULL DEFAULT 14,       -- keep the most recent N snapshots
  last_backup_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stored snapshots. `data` is the same JSON envelope the manual export produces.
CREATE TABLE IF NOT EXISTS backup_snapshots (
  id             SERIAL PRIMARY KEY,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  label          TEXT NOT NULL DEFAULT 'auto',
  bytes          BIGINT NOT NULL DEFAULT 0,
  schema_version INTEGER,
  data           BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_snapshots_household ON backup_snapshots(household_id, created_at DESC);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE household_backup_settings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE household_backup_settings FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS household_backup_settings_tenant_isolation ON household_backup_settings';
  EXECUTE 'CREATE POLICY household_backup_settings_tenant_isolation ON household_backup_settings
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
  EXECUTE 'ALTER TABLE backup_snapshots ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE backup_snapshots FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS backup_snapshots_tenant_isolation ON backup_snapshots';
  EXECUTE 'CREATE POLICY backup_snapshots_tenant_isolation ON backup_snapshots
             USING (household_id = current_setting(''app.household_id'', true)::int)
             WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)';
END $$;
