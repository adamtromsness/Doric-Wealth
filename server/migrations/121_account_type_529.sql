-- Add `529` (college savings plan) as a first-class account type. Previously a 529
-- was folded into the broad `retirement` type; it now stands on its own and groups
-- under Investments in the UI.
--
-- Additive + idempotent + safe for existing installs: the new set is a strict
-- superset of the previous one (055_account_type_crypto), so no existing row is
-- invalidated, and DROP ... IF EXISTS makes it re-runnable.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN (
  'checking','savings','credit_card','hsa','fsa','money_market','cd',
  'investment','retirement','529','brokerage','crypto','loan','mortgage','cash','asset','other'
));
