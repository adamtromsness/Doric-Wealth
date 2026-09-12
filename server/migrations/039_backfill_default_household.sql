-- Adopt all pre-existing (single-tenant) data into one legacy household so the
-- app can become multi-tenant without losing the operator's data. The first user
-- created by `npm run bootstrap` becomes the owner of this household.
--
-- Idempotent + safe on fresh installs: a legacy household is only created when
-- there is legacy data to adopt (existing accounts/transactions with no household),
-- and backfill only touches rows whose household_id is still NULL.

DO $$
DECLARE
  hh INT;
  t  TEXT;
  has_legacy BOOLEAN;
  tables TEXT[] := ARRAY[
    'accounts','account_balances','transactions','transaction_splits','line_tags',
    'categories','receipts','receipt_items','budgets','budget_lines','budget_accounts',
    'goals','subscriptions','utility_accounts','utility_invoices','utility_invoice_lines',
    'utility_invoice_payments','vehicles','properties','assets','liabilities','ai_analyses'
  ];
BEGIN
  -- Is there any un-tenanted legacy data to adopt?
  SELECT EXISTS (SELECT 1 FROM accounts WHERE household_id IS NULL)
      OR EXISTS (SELECT 1 FROM transactions WHERE household_id IS NULL)
      OR EXISTS (SELECT 1 FROM categories WHERE household_id IS NULL)
    INTO has_legacy;

  IF NOT has_legacy THEN
    RETURN; -- fresh install, or already fully backfilled
  END IF;

  -- Reuse the oldest household as the legacy one, or create it.
  SELECT id INTO hh FROM households ORDER BY id LIMIT 1;
  IF hh IS NULL THEN
    INSERT INTO households (name) VALUES ('My Household') RETURNING id INTO hh;
  END IF;

  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET household_id = %L WHERE household_id IS NULL', t, hh);
    END IF;
  END LOOP;
END $$;
