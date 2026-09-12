-- Finish the household -> books rename: rename the per-request RLS GUC from
-- `app.household_id` to `app.book_id`.
--
-- Migration 122 renamed the `household_id` column to `book_id`; that auto-updated
-- the COLUMN references inside every RLS policy. What it could NOT touch is the
-- string literal naming the runtime session variable -- `current_setting('app.household_id')`
-- -- because a string is not a schema reference. This migration rewrites that literal
-- in every policy, and the app is updated to call set_config('app.book_id', ...).
--
-- Approach: catalog-driven. We read each policy's CURRENT definition from
-- pg_policies and recreate it with only the GUC literal swapped, so any policy with
-- a non-standard shape is reproduced faithfully rather than flattened to a template.
-- Each DROP+CREATE pair runs inside the migration's single transaction, so tenant
-- isolation is never relaxed mid-flight (a failure rolls the whole file back).
--
-- Idempotent: once a policy references `app.book_id` it no longer matches the
-- filter, so a re-run is a no-op.

DO $$
DECLARE
  p        RECORD;
  v_using  TEXT;
  v_check  TEXT;
  v_roles  TEXT;
  sql      TEXT;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (COALESCE(qual, '')       LIKE '%app.household_id%'
         OR COALESCE(with_check, '') LIKE '%app.household_id%')
  LOOP
    v_using := replace(p.qual,       'app.household_id', 'app.book_id');
    v_check := replace(p.with_check, 'app.household_id', 'app.book_id');

    -- Preserve the policy's roles exactly (these are all PUBLIC today, but don't
    -- assume it). `public` is a keyword and must stay unquoted; real roles get quoted.
    SELECT string_agg(CASE WHEN r = 'public' THEN 'public' ELSE quote_ident(r) END, ', ')
      INTO v_roles
      FROM unnest(p.roles) AS r;

    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);

    sql := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
                  p.policyname, p.schemaname, p.tablename,
                  p.permissive,            -- 'PERMISSIVE' | 'RESTRICTIVE'
                  p.cmd,                   -- 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
                  v_roles);
    IF p.qual       IS NOT NULL THEN sql := sql || format(' USING (%s)',      v_using); END IF;
    IF p.with_check IS NOT NULL THEN sql := sql || format(' WITH CHECK (%s)', v_check); END IF;

    EXECUTE sql;
  END LOOP;
END $$;
