-- Freeze the group (parent-category) label alongside the already-frozen item
-- label, so closing a budget period also pins its section headings. Without this,
-- renaming a parent category after a period closes would rewrite historical
-- group headings in /api/budgets/:id/progress.
-- Existing snapshots keep NULL group columns; the progress query falls back to the
-- live category data for those, so old installs migrate safely and only periods
-- snapshotted from now on get fully frozen headings.
ALTER TABLE budget_period_lines ADD COLUMN IF NOT EXISTS group_id   INTEGER;
ALTER TABLE budget_period_lines ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE budget_period_lines ADD COLUMN IF NOT EXISTS group_sort INTEGER;

-- Backfill existing snapshots from CURRENT category/parent data, so periods closed
-- before this migration are frozen at their migration-time labels rather than
-- tracking later parent renames. Idempotent: only fills rows not yet frozen, and a
-- snapshot whose category was since deleted simply stays NULL (the progress query
-- falls back to the frozen item label for those).
UPDATE budget_period_lines bpl
SET group_id   = COALESCE(p.id, c.id),
    group_name = COALESCE(p.name, c.name),
    group_sort = COALESCE(p.sort_order, c.sort_order)
FROM categories c
LEFT JOIN categories p ON p.id = c.parent_id
WHERE c.id = bpl.category_id AND bpl.group_name IS NULL;
