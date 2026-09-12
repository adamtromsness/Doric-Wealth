-- Rename the "household" concept to "books" throughout the schema.
--
--   Tables : households -> books, household_backup_settings -> book_backup_settings
--   Columns: <table>.household_id -> book_id (every tenant table),
--            sessions.active_household_id -> active_book_id
--   Names  : indexes / constraints / RLS policies / sequences whose NAME contains
--            "household" are renamed to "book" for consistency.
--
-- Why this is safe: PostgreSQL tracks dependent objects by column number, not by
-- name, so RENAME COLUMN automatically rewrites every place the column is
-- referenced -- FK constraints, (partial) index predicates, unique constraints, and
-- RLS policy USING / WITH CHECK expressions. We therefore never drop/recreate a
-- policy or index; we only rename the object NAMES (which do not auto-follow).
--
-- At the time THIS migration ran, the runtime GUC 'app.household_id' (set per-request
-- by the app for RLS) was deliberately left UNCHANGED, so that renaming columns did not
-- also force a rewrite of the RLS policy expressions (a security boundary) in the same
-- step. NOTE: this was SUPERSEDED by migration 123, which rewrote the policies and the
-- runtime GUC to 'app.book_id'. The app now calls set_config('app.book_id') (see
-- src/tenant.ts); 'app.household_id' is no longer used anywhere.
--
-- Every step is guarded so a re-run is a no-op (matches the repo's idempotent style).

-- 1. Tables ------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.households') IS NOT NULL AND to_regclass('public.books') IS NULL THEN
    EXECUTE 'ALTER TABLE households RENAME TO books';
  END IF;
  IF to_regclass('public.household_backup_settings') IS NOT NULL
     AND to_regclass('public.book_backup_settings') IS NULL THEN
    EXECUTE 'ALTER TABLE household_backup_settings RENAME TO book_backup_settings';
  END IF;
END $$;

-- 2. Columns: household_id -> book_id, active_household_id -> active_book_id ---
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name = 'household_id'
       AND NOT EXISTS (
             SELECT 1 FROM information_schema.columns c2
              WHERE c2.table_schema = 'public'
                AND c2.table_name  = c.table_name
                AND c2.column_name = 'book_id')
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME COLUMN household_id TO book_id', r.table_name);
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='sessions'
                AND column_name='active_household_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='sessions'
                AND column_name='active_book_id') THEN
    EXECUTE 'ALTER TABLE sessions RENAME COLUMN active_household_id TO active_book_id';
  END IF;
END $$;

-- 3. Constraints whose name contains 'household' (FKs auto-named *_household_id_fkey,
--    PKs like households_pkey, etc.). Renaming a constraint also renames its backing
--    index, so do this BEFORE the index pass to avoid touching them twice. -------
DO $$
DECLARE r RECORD; newname TEXT;
BEGIN
  FOR r IN
    SELECT con.conname, rel.relname AS table_name
      FROM pg_constraint con
      JOIN pg_class     rel ON rel.oid = con.conrelid
      JOIN pg_namespace n   ON n.oid   = rel.relnamespace
     WHERE n.nspname = 'public'
       AND con.conname LIKE '%household%'
  LOOP
    newname := replace(r.conname, 'household', 'book');
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.table_name, r.conname, newname);
  END LOOP;
END $$;

-- 4. Indexes whose name contains 'household' (standalone CREATE INDEX objects) ----
DO $$
DECLARE r RECORD; newname TEXT;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname LIKE '%household%'
  LOOP
    newname := replace(r.indexname, 'household', 'book');
    IF to_regclass('public.' || quote_ident(newname)) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, newname);
    END IF;
  END LOOP;
END $$;

-- 5. Sequences whose name contains 'household' (e.g. households_id_seq). The column
--    default that calls nextval() auto-follows the rename. -----------------------
DO $$
DECLARE r RECORD; newname TEXT;
BEGIN
  FOR r IN
    SELECT c.relname AS seqname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S' AND n.nspname = 'public' AND c.relname LIKE '%household%'
  LOOP
    newname := replace(r.seqname, 'household', 'book');
    IF to_regclass('public.' || quote_ident(newname)) IS NULL THEN
      EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', r.seqname, newname);
    END IF;
  END LOOP;
END $$;

-- 6. RLS policies whose name contains 'household' (e.g. the explicitly-named
--    household_backup_settings_tenant_isolation). Policy bodies already follow the
--    column rename; only the policy NAME needs updating. --------------------------
DO $$
DECLARE r RECORD; newname TEXT;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies
     WHERE schemaname = 'public' AND policyname LIKE '%household%'
  LOOP
    newname := replace(r.policyname, 'household', 'book');
    EXECUTE format('ALTER POLICY %I ON %I RENAME TO %I', r.policyname, r.tablename, newname);
  END LOOP;
END $$;
