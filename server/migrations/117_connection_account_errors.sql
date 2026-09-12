-- The SimpleFIN /accounts response carries a free-text errors[] array (e.g. an
-- institution that needs re-authentication). We already fetch it but discarded it;
-- store the latest set per connection so the UI can flag connections that need
-- attention. Additive & idempotent.
ALTER TABLE institution_links ADD COLUMN IF NOT EXISTS account_errors TEXT[] NOT NULL DEFAULT '{}';
