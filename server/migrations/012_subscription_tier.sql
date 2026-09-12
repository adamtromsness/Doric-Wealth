-- Optional plan tier / level for a subscription (e.g. Netflix "Premium 4K").
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS tier TEXT;
