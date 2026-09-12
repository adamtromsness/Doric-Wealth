import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('reconciliation items must belong to the session account', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const other = (await client.post('/api/accounts', { name: 'Savings', type: 'savings' })).body.id;

  const session = (await client.post('/api/reconciliations', { account_id: acct })).body;

  // 1. A transaction posted directly to the session account is accepted.
  const onAccount = (await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-05-01' })).body;
  const r1 = await client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: onAccount.id });
  assert.equal(r1.status, 201, 'same-account transaction should be accepted');

  // 2. A transfer whose other side is the session account is accepted.
  const transfer = (await client.post('/api/transactions', { amount: 25, account_id: other, transfer_account_id: acct, direction: 'transfer', txn_date: '2026-05-02' })).body;
  const r2 = await client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: transfer.id });
  assert.equal(r2.status, 201, 'transfer involving the account should be accepted');

  // 3. An unrelated same-book transaction (different account, not a transfer) is rejected.
  const unrelated = (await client.post('/api/transactions', { amount: 15, account_id: other, direction: 'expense', txn_date: '2026-05-03' })).body;
  const r3 = await client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: unrelated.id });
  assert.equal(r3.status, 400, 'unrelated same-book transaction should be rejected');
  assert.match(r3.body.error, /does not belong/i);
});

test('reconciliation items reject cross-book transactions (404)', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);

  const acctA = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const session = (await a.client.post('/api/reconciliations', { account_id: acctA })).body;

  const acctB = (await b.client.post('/api/accounts', { name: 'B', type: 'checking' })).body.id;
  const txnB = (await b.client.post('/api/transactions', { amount: 5, account_id: acctB, direction: 'expense', txn_date: '2026-05-04' })).body;

  // A's session cannot clear B's transaction — it isn't visible in A's book.
  const r = await a.client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: txnB.id });
  assert.equal(r.status, 404, 'cross-book transaction should be rejected');
});
