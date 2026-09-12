-- Manual ordering for categories (drag-to-reorder). Groups are ordered within
-- their kind; items are ordered within their group.
--
-- The backfill is one-shot: it runs only when the column is first created, so
-- re-running migrations never clobbers a user's manual ordering.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'categories' AND column_name = 'sort_order'
  ) THEN
    ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

    -- Preserve the current display order: groups income-first then name,
    -- items alphabetical within their group.
    UPDATE categories c SET sort_order = sub.rn
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY (kind = 'income') DESC, lower(name)) - 1 AS rn
      FROM categories WHERE parent_id IS NULL
    ) sub WHERE c.id = sub.id;

    UPDATE categories c SET sort_order = sub.rn
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY lower(name)) - 1 AS rn
      FROM categories WHERE parent_id IS NOT NULL
    ) sub WHERE c.id = sub.id;
  END IF;
END $$;
