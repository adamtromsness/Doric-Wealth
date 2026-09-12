-- Split a transaction into parts, each with its own category and tags. When a
-- transaction has splits, the splits drive budgets and the per-vehicle/property/
-- subscription rollups instead of the transaction's own top-level category/tags.
-- Per-split tags live in the many-to-many line_tags table (migration 019).
CREATE TABLE IF NOT EXISTS transaction_splits (
  id              SERIAL PRIMARY KEY,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount          NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  category_id     INTEGER REFERENCES categories(id)    ON DELETE SET NULL,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_splits_txn ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_splits_category ON transaction_splits(category_id);
