-- Defense-in-depth: Postgres row-level security on every tenant table. Even if an
-- app-layer WHERE clause is ever missed, the database itself restricts rows to the
-- active household. The app binds one connection per request and sets
-- `app.household_id` on it (see tenant.ts / db.ts); these policies compare each
-- row's household_id against that GUC. When the GUC is unset, current_setting(...,
-- true) is NULL and the comparison yields no rows / blocks writes (default deny).
--
-- FORCE is required because the app connects as the table owner, who would
-- otherwise bypass RLS. receipt_items is intentionally excluded — it carries no
-- reliable household_id and is only reached by joining its (protected) parent
-- receipt. Identity tables (users, households, memberships, sessions, invites) are
-- excluded too: they're keyed by session/token, not household, and back the auth
-- flow that resolves which household a request belongs to.
-- Idempotent: policies are dropped + recreated; ENABLE/FORCE are no-ops on re-run.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'accounts','account_balances','transactions','transaction_splits','line_tags',
    'categories','receipts','budgets','budget_lines','budget_accounts','goals',
    'subscriptions','utility_accounts','utility_invoices','utility_invoice_lines',
    'utility_invoice_payments','vehicles','properties','assets','liabilities','ai_analyses'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I
           USING (household_id = current_setting(''app.household_id'', true)::int)
           WITH CHECK (household_id = current_setting(''app.household_id'', true)::int)',
        t || '_tenant_isolation', t
      );
    END IF;
  END LOOP;
END $$;
