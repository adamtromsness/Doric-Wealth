-- Per-user IANA timezone (e.g. 'America/Los_Angeles'), so date logic that can't take
-- a client-supplied "today" — the SimpleFIN sync's epoch→date conversion (runs
-- server-side / scheduled) and the server-side "today" defaults for budgets/goals —
-- resolves in the user's local zone instead of the server's UTC day. NULL = UTC.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;
