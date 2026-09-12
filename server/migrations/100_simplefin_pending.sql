-- Opt-in: include still-pending transactions when syncing a SimpleFIN connection.
-- Off by default — pending items can have unstable ids until they post, so the
-- conservative default is posted-only. Additive & idempotent.
ALTER TABLE institution_links ADD COLUMN IF NOT EXISTS include_pending BOOLEAN NOT NULL DEFAULT false;
