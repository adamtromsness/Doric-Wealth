-- Remembers a dismissed "update from SimpleFIN" suggestion for a mapped account: the
-- signature of the proposed values the user ignored. The suggestion stays hidden until
-- SimpleFIN reports different values (a new signature). Additive & idempotent.
ALTER TABLE account_links ADD COLUMN IF NOT EXISTS dismissed_suggestion TEXT;
