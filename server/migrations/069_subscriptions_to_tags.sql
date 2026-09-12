-- Convert subscriptions from auto-managed CATEGORIES to TAGS (kind='subscription').
-- For every charge categorized to a managed subscription category: add a
-- subscription line-tag, then re-point its category to the subscription's own
-- (real) category. Finally drop the managed subscription categories + group.
-- Idempotent: once the managed categories are gone, the loop/cleanup are no-ops.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.id AS cat_id, c.source_id AS sub_id, c.household_id, s.category_id AS real_cat
      FROM categories c
      JOIN subscriptions s ON s.id = c.source_id AND s.household_id = c.household_id
     WHERE c.managed AND c.source_kind = 'subscription' AND c.source_id IS NOT NULL
  LOOP
    -- Transaction-level charges.
    INSERT INTO line_tags (transaction_id, split_id, kind, ref_id, household_id)
    SELECT t.id, NULL, 'subscription', r.sub_id, r.household_id
      FROM transactions t
     WHERE t.category_id = r.cat_id AND t.household_id = r.household_id
       AND NOT EXISTS (SELECT 1 FROM line_tags lt WHERE lt.transaction_id = t.id AND lt.kind = 'subscription' AND lt.ref_id = r.sub_id);
    UPDATE transactions SET category_id = r.real_cat WHERE category_id = r.cat_id AND household_id = r.household_id;

    -- Split-level charges.
    INSERT INTO line_tags (transaction_id, split_id, kind, ref_id, household_id)
    SELECT NULL, sp.id, 'subscription', r.sub_id, r.household_id
      FROM transaction_splits sp
     WHERE sp.category_id = r.cat_id AND sp.household_id = r.household_id
       AND NOT EXISTS (SELECT 1 FROM line_tags lt WHERE lt.split_id = sp.id AND lt.kind = 'subscription' AND lt.ref_id = r.sub_id);
    UPDATE transaction_splits SET category_id = r.real_cat WHERE category_id = r.cat_id AND household_id = r.household_id;

    DELETE FROM budget_lines WHERE category_id = r.cat_id;
    DELETE FROM categories WHERE id = r.cat_id;
  END LOOP;

  -- Orphan managed subscription items (their subscription was already deleted):
  -- just uncategorize their charges and remove them (nothing to tag them to).
  UPDATE transactions t SET category_id = NULL
    FROM categories c WHERE c.id = t.category_id AND c.managed AND c.source_kind = 'subscription';
  UPDATE transaction_splits sp SET category_id = NULL
    FROM categories c WHERE c.id = sp.category_id AND c.managed AND c.source_kind = 'subscription';
  DELETE FROM budget_lines WHERE category_id IN (SELECT id FROM categories WHERE managed AND source_kind = 'subscription');
  DELETE FROM categories WHERE managed AND source_kind = 'subscription';

  -- Drop the now-empty managed "Subscriptions" group(s).
  DELETE FROM budget_lines WHERE category_id IN (
    SELECT id FROM categories WHERE managed AND source_kind = 'subscriptions' AND parent_id IS NULL
  );
  DELETE FROM categories
   WHERE managed AND source_kind = 'subscriptions' AND parent_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = categories.id);
END $$;
