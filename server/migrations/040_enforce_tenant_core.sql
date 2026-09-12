-- Enforce tenant ownership on the tables wired in Phase 1 (accounts + transactions
-- and their children). Each is set NOT NULL only once no orphan (NULL household_id)
-- rows remain, so this stays safe on fresh/partial states and re-runs (SET NOT NULL
-- on an already-NOT NULL column is a no-op). Other tables get NOT NULL in Phase 2.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'accounts','account_balances','transactions','transaction_splits','line_tags'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format(
        'DO $inner$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM %1$I WHERE household_id IS NULL) THEN
             ALTER TABLE %1$I ALTER COLUMN household_id SET NOT NULL;
           END IF;
         END $inner$;', t);
    END IF;
  END LOOP;
END $$;
