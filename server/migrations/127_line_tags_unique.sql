-- Enforce line-tag uniqueness so a tag can't attach to the same transaction/split
-- twice. Concurrent suggestion-confirm or pay flows could otherwise insert a duplicate
-- (subscription/vehicle/property) tag and double-count it in spending rollups. split_id
-- is nullable, so two partial unique indexes cover the transaction-level and split-level
-- shapes. Dedupe any existing duplicates first (keep the lowest id) so the indexes build.
DELETE FROM line_tags a USING line_tags b
WHERE a.id > b.id
  AND a.book_id = b.book_id AND a.kind = b.kind AND a.ref_id = b.ref_id
  AND a.transaction_id IS NOT DISTINCT FROM b.transaction_id
  AND a.split_id IS NOT DISTINCT FROM b.split_id;

CREATE UNIQUE INDEX IF NOT EXISTS line_tags_txn_uniq
  ON line_tags(book_id, transaction_id, kind, ref_id)
  WHERE transaction_id IS NOT NULL AND split_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS line_tags_split_uniq
  ON line_tags(book_id, split_id, kind, ref_id)
  WHERE split_id IS NOT NULL;
