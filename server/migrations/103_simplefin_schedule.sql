-- Scheduled auto-import settings per connection. auto_import_enabled gates the
-- background poll; frequency controls how often it runs. Default ON + daily so
-- existing connections keep their current daily auto-sync behavior. Additive &
-- idempotent.
ALTER TABLE institution_links ADD COLUMN IF NOT EXISTS auto_import_enabled   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE institution_links ADD COLUMN IF NOT EXISTS auto_import_frequency TEXT NOT NULL DEFAULT 'daily';  -- daily | weekly
