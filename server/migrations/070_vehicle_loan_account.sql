-- Associate a vehicle with a car loan. When set, the vehicle's loan is managed as
-- this liability account (so the debt is counted once — via the account — and the
-- balance/rate/payments are tracked on the Accounts page).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS loan_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_vehicles_loan_account ON vehicles(loan_account_id);
