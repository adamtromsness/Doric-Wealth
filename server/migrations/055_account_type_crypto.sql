-- Reconcile the canonical account type list with the UI. Adds `crypto` as a
-- first-class account type (the Accounts screen already groups crypto under
-- Investments). Retirement subtypes (IRA / 401k / 529) remain represented by the
-- broad `retirement` type, and loan subtypes (auto / student / personal) live on
-- the `liabilities` table's liability_type — not here.
--
-- Additive + idempotent + safe for existing installs: the new set is a strict
-- superset of the previous one (008_account_types), so no existing row is
-- invalidated, and DROP ... IF EXISTS makes it re-runnable.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN (
  'checking','savings','credit_card','hsa','fsa','money_market','cd',
  'investment','retirement','brokerage','crypto','loan','mortgage','cash','asset','other'
));
