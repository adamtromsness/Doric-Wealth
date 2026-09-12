-- Finer scheduled auto-import controls: a start date/time anchor (the schedule fires
-- at this time, then every frequency interval after), and a per-account opt-in so a
-- connection can auto-import only some of its mapped accounts. Additive & idempotent.
ALTER TABLE institution_links ADD COLUMN IF NOT EXISTS auto_import_start_at TIMESTAMPTZ;
ALTER TABLE account_links     ADD COLUMN IF NOT EXISTS auto_import BOOLEAN NOT NULL DEFAULT true;
