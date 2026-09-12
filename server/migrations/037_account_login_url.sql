-- Bank login URL for an account, shown as a clickable link in the accounts list.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS login_url TEXT;
