-- When a subscription is canceled, record the effective date.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS end_date DATE;
