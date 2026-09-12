-- Let a transfer (e.g. a loan/mortgage payment) be broken into split lines where
-- some lines pay down the destination liability's principal and others are costs
-- (interest, escrow, fees). is_principal marks the principal lines: only their
-- summed amount reduces the loan balance; the rest surface as expenses. Only
-- meaningful on splits of a transfer into a liability; harmless (and ignored)
-- elsewhere. Idempotent.

ALTER TABLE transaction_splits ADD COLUMN IF NOT EXISTS is_principal BOOLEAN NOT NULL DEFAULT false;
