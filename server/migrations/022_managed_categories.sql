-- Auto-managed categories: groups/items the system keeps in sync from another
-- entity (utility accounts, subscriptions). They are real categories — selectable
-- for transactions and budgets — but locked from manual editing.
--   managed=true             -> maintained by the system
--   source_kind              -> 'utilities'/'subscriptions' (groups); 'utility'/'subscription' (items)
--   source_id                -> the utility_account.id / subscription.id (items only)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS source_id INTEGER;

-- At most one managed group per source_kind, and one managed item per source row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_managed_group
  ON categories (source_kind) WHERE managed AND parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_managed_item
  ON categories (source_kind, source_id) WHERE managed AND source_id IS NOT NULL;
