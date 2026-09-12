-- Record WHY an imported row was auto-skipped, so the review queue can explain
-- it and let the user add it anyway. Idempotent.
--   'duplicate_in_file' = same date+amount+merchant appeared earlier in the file
--   'matches_existing'   = looks like a transaction already in the ledger (see duplicate_of)
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS skip_reason TEXT;
