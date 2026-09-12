import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('GET /accounts/:id returns one account with computed fields, scoped to the book', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 100 })).body.id;

  const one = await client.get(`/api/accounts/${acct}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.id, acct);
  assert.equal(one.body.name, 'Checking');
  // Same computed shape as the list item (posted balance + status), not just the row.
  assert.equal(Number(one.body.posted_balance), 100);
  assert.equal(one.body.status, 'active');

  // Missing id → 404.
  assert.equal((await client.get('/api/accounts/99999')).status, 404);

  // Another book cannot read it → 404 (tenant scoped).
  const other = await registerUser(base);
  assert.equal((await other.client.get(`/api/accounts/${acct}`)).status, 404);
});

// Characterization of the ACCOUNT_BALANCES computation (effectiveLines.ts): the
// posted balance = latest snapshot + posted deltas dated AFTER it (pre-snapshot ones
// are already reflected in the snapshot), and the pending balance adds all not-yet-
// posted deltas of any date. Locks the math so any future optimization of that CTE
// must reproduce it exactly.
test('computed balance = snapshot anchor + post-anchor posted deltas (+ pending)', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 100 })).body.id;
  // Anchor: a dated balance snapshot of 1000 on 2026-01-01.
  await client.post(`/api/accounts/${acct}/balances`, { balance: 1000, as_of: '2026-01-01' });
  // A posted income AFTER the anchor → adds to the posted balance.
  await client.post('/api/transactions', { amount: 200, account_id: acct, direction: 'income', txn_date: '2026-02-01', posted_date: '2026-02-01' });
  // A posted expense BEFORE the anchor → already in the snapshot, must NOT count again.
  await client.post('/api/transactions', { amount: 500, account_id: acct, direction: 'expense', txn_date: '2025-12-01', posted_date: '2025-12-01' });
  // A still-pending expense (posted_date null) → only in the pending balance.
  await client.post('/api/transactions', { amount: 50, account_id: acct, direction: 'expense', txn_date: '2026-02-15', posted_date: null });

  const a = (await client.get(`/api/accounts/${acct}`)).body;
  assert.equal(Number(a.posted_balance), 1200, 'anchor 1000 + post-anchor income 200; pre-anchor 500 excluded');
  assert.equal(Number(a.pending_balance), 1150, 'posted 1200 minus the pending 50');
});
