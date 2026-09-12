-- receipt_items was the one tenant table left out of the row-level-security sweep
-- in 042, on the (now outdated) assumption that it "carries no reliable
-- household_id". In practice every write stamps household_id (see
-- routes/transactions.ts and seed.ts), so we can close the last RLS gap and give
-- receipt_items the same defense-in-depth as every other tenant table.
--
-- Idempotent: backfill is a no-op once filled; ENABLE/FORCE are no-ops on re-run;
-- the policy is dropped + recreated. Mirrors the exact shape used in 042.

-- Defensive backfill: stamp any historical rows that predate household stamping,
-- pulling the owner from the (already tenant-scoped) parent receipt. Orphans with
-- no parent keep a NULL household_id and become invisible under RLS (correct).
UPDATE receipt_items ri
   SET household_id = r.household_id
  FROM receipts r
 WHERE ri.receipt_id = r.id
   AND ri.household_id IS DISTINCT FROM r.household_id;

ALTER TABLE receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receipt_items_tenant_isolation ON receipt_items;
CREATE POLICY receipt_items_tenant_isolation ON receipt_items
  USING (household_id = current_setting('app.household_id', true)::int)
  WITH CHECK (household_id = current_setting('app.household_id', true)::int);
