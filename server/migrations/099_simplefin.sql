-- Automatic transaction import via SimpleFIN Bridge. A household links one (or
-- more) SimpleFIN connections; each connection exposes one or more external bank
-- accounts, which the user maps to internal accounts. Synced transactions are
-- deduped by their stable provider id and staged for review (reusing the CSV
-- import pipeline). Additive & idempotent; RLS mirrors migration 042.

-- A linked provider connection. access_url_enc holds the SimpleFIN access URL
-- (which embeds read-only basic-auth credentials), encrypted at rest — never
-- stored in plaintext. One row per claimed setup token.
CREATE TABLE IF NOT EXISTS institution_links (
  id             SERIAL PRIMARY KEY,
  household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL DEFAULT 'simplefin',
  access_url_enc TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',   -- active | error | revoked
  last_synced_at TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_institution_links_household ON institution_links(household_id);

-- An external account exposed by a connection, optionally mapped to an internal
-- account. Until account_id is set, the account's transactions are not synced.
CREATE TABLE IF NOT EXISTS account_links (
  id                  SERIAL PRIMARY KEY,
  household_id        INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  link_id             INTEGER NOT NULL REFERENCES institution_links(id) ON DELETE CASCADE,
  external_account_id TEXT NOT NULL,
  account_id          INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  org_name            TEXT,
  currency            TEXT,
  last_balance        NUMERIC(16,2),
  last_balance_date   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (link_id, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_account_links_household ON account_links(household_id);

-- Provider provenance + dedup backbone on the ledger. external_id is the SimpleFIN
-- transaction id; the partial unique index makes re-syncing idempotent (the same
-- provider transaction can never be inserted twice for a household+source).
ALTER TABLE transactions        ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE transactions        ADD COLUMN IF NOT EXISTS source      TEXT;
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_external
  ON transactions (household_id, source, external_id)
  WHERE external_id IS NOT NULL;

-- Row-level security (defense-in-depth), matching migration 042's pattern.
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY['institution_links', 'account_links'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (household_id = current_setting(''app.household_id'', true)::int)
         WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
