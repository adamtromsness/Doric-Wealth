-- The originating normalized merchant key a subscription was detected from, so
-- its future charges can be matched and excluded from re-detection even after
-- the subscription is renamed to something user-friendly. Idempotent.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS merchant_key TEXT;
CREATE INDEX IF NOT EXISTS idx_subscriptions_merchant_key ON subscriptions(household_id, merchant_key);
