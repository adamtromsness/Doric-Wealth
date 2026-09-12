-- Broaden the set of account types (HSA, FSA, money market, CD, retirement,
-- brokerage, mortgage, ...). 'other' remains the catch-all for anything else.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN (
  'checking','savings','credit_card','hsa','fsa','money_market','cd',
  'investment','retirement','brokerage','loan','mortgage','cash','asset','other'
));
