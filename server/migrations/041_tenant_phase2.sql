-- Phase 2: make category uniqueness per-household, and enforce NOT NULL
-- household_id on the remaining tenant tables now that every route stamps it.
-- Idempotent.

-- Category name uniqueness must be scoped per household so two households can each
-- have their own "Groceries" group, etc. (Child uniqueness is already scoped by
-- parent_id, which belongs to a single household.)
DROP INDEX IF EXISTS uq_categories_top;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_top
  ON categories (household_id, lower(name)) WHERE parent_id IS NULL;

DROP INDEX IF EXISTS uq_categories_managed_group;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_managed_group
  ON categories (household_id, source_kind) WHERE managed AND parent_id IS NULL;

DROP INDEX IF EXISTS uq_categories_managed_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_managed_item
  ON categories (household_id, source_kind, source_id) WHERE managed AND source_id IS NOT NULL;

-- Enforce NOT NULL on the tables wired in Phase 2 (only once no orphan rows
-- remain, so this is safe on fresh/partial states and re-runs). receipt_items is
-- intentionally excluded — it is scoped via its parent receipt, not stamped.
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'categories','receipts','budgets','budget_lines','budget_accounts','goals',
    'subscriptions','utility_accounts','utility_invoices','utility_invoice_lines',
    'utility_invoice_payments','vehicles','properties','assets','liabilities','ai_analyses'
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
