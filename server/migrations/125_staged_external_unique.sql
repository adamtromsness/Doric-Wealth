-- Stop the same provider transaction from being staged twice. The in-app dedup in
-- the SimpleFIN sync can't see another concurrent sync's not-yet-committed staged row,
-- so two overlapping syncs (e.g. a manual one while the scheduled poll runs) can both
-- insert the same external_id. Those duplicates then collide on the posted-transaction
-- unique index at confirm time and roll back the WHOLE bulk confirm. A partial unique
-- index makes the duplicate insert a no-op (paired with ON CONFLICT DO NOTHING in the
-- sync), so confirm stays clean.
--
-- First remove any duplicates that already slipped in (keep the earliest staged row),
-- then enforce uniqueness for provider rows (CSV rows have a NULL external_id and are
-- intentionally excluded).
DELETE FROM staged_transactions s
 USING staged_transactions keep
 WHERE s.external_id IS NOT NULL
   AND keep.external_id = s.external_id
   AND keep.book_id     = s.book_id
   AND keep.source      = s.source
   AND keep.id          < s.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staged_external
  ON staged_transactions (book_id, source, external_id)
  WHERE external_id IS NOT NULL;
