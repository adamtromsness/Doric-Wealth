-- Production hardening: composite indexes for the hot access paths that degrade
-- once a book holds years of data. The per-table single-column book_id indexes
-- (migration 038) don't cover the real (filter + sort) and (join) shapes below.
--
-- All are CREATE INDEX IF NOT EXISTS so this is safe to re-run. NOTE: migrations
-- run inside a transaction here, so we can't use CREATE INDEX CONCURRENTLY; on a
-- very large PRODUCTION table you may prefer to build these out-of-band with
-- CONCURRENTLY to avoid a brief write lock. On the current data sizes the inline
-- build is quick.

-- Trigram search for merchant ILIKE '%q%' (transaction search + similar). Without
-- this every search is a full scan. pg_trgm is a trusted extension (DB owner can
-- create it).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_txn_merchant_trgm
  ON transactions USING gin (merchant gin_trgm_ops);

-- The hot transaction list + sort, dashboard flows, and net-worth cash-flow all
-- filter by book and sort by (txn_date DESC, id DESC).
CREATE INDEX IF NOT EXISTS idx_txn_book_date
  ON transactions (book_id, txn_date DESC, id DESC);

-- CSV-import dedup probe (imports.ts): account + amount + direction + nearby date.
CREATE INDEX IF NOT EXISTS idx_txn_dedup
  ON transactions (book_id, account_id, amount, direction, txn_date);

-- SimpleFIN per-transaction category inheritance looks up prior rows by merchant.
CREATE INDEX IF NOT EXISTS idx_txn_book_merchant
  ON transactions (book_id, lower(merchant), txn_date DESC)
  WHERE category_id IS NOT NULL;

-- net-worth "as of <= date" correlated subqueries sort each entity's history by
-- as_of DESC; today only single-column id indexes exist on these tables.
CREATE INDEX IF NOT EXISTS idx_property_values_prop_asof
  ON property_values (property_id, as_of DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_asset_values_asset_asof
  ON asset_values (asset_id, as_of DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_liability_balances_liab_asof
  ON liability_balances (liability_id, as_of DESC, id DESC);

-- staged-transaction review/confirm filters by (book, account, decision).
CREATE INDEX IF NOT EXISTS idx_staged_book_account_decision
  ON staged_transactions (book_id, account_id, decision);

-- receipt-item reporting buckets by the parent receipt's purchase month.
CREATE INDEX IF NOT EXISTS idx_receipts_book_purchased
  ON receipts (book_id, purchased_at);
