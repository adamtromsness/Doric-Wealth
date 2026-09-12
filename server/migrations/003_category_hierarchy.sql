-- Two-level category hierarchy: a category may have a parent.
--   parent_id IS NULL          -> high-level group (e.g. "Utilities")
--   parent_id IS NOT NULL      -> budget item under a group (e.g. "Electricity")
-- Transactions and budget allocations attach to a leaf (a category with no children).

ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE;

-- Names only need to be unique within their level/parent, not globally, so the
-- same item name ("Other") can exist under different groups.
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_top
  ON categories (lower(name)) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_child
  ON categories (parent_id, lower(name)) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
