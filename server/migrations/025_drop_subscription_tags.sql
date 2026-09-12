-- Subscriptions are represented as managed categories now, so the separate
-- 'subscription' line tag is redundant. Where a tagged transaction/split has no
-- category yet, file it under the managed subscription category; then drop all
-- subscription tags. (Tagged lines that already have a category keep it.)
--
-- One-shot: the body only runs while legacy subscription tags still exist, so
-- re-running migrations can never re-categorize transactions later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM line_tags WHERE kind = 'subscription') THEN
    UPDATE transactions t SET category_id = mc.id
    FROM line_tags lt
    JOIN categories mc ON mc.managed AND mc.source_kind = 'subscription' AND mc.source_id = lt.ref_id
    WHERE lt.kind = 'subscription' AND lt.transaction_id = t.id AND t.category_id IS NULL;

    UPDATE transaction_splits s SET category_id = mc.id
    FROM line_tags lt
    JOIN categories mc ON mc.managed AND mc.source_kind = 'subscription' AND mc.source_id = lt.ref_id
    WHERE lt.kind = 'subscription' AND lt.split_id = s.id AND s.category_id IS NULL;

    DELETE FROM line_tags WHERE kind = 'subscription';
  END IF;
END $$;
