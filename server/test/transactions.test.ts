import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('transfers get explicit linkage and preserve transfer_account_id', async () => {
  const { client } = await registerUser(base);
  const a1 = (await client.post('/api/accounts', { name: 'A1', type: 'checking' })).body.id;
  const a2 = (await client.post('/api/accounts', { name: 'A2', type: 'savings' })).body.id;
  const tr = await client.post('/api/transactions', { amount: 50, account_id: a1, transfer_account_id: a2, direction: 'transfer', txn_date: '2026-06-10' });
  assert.equal(tr.status, 201);
  assert.equal(tr.body.transfer_account_id, a2);
  assert.match(tr.body.transfer_group_id, /^tg-/);
});

test('split totals must equal the transaction amount', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  const bad = await client.post('/api/transactions', { amount: 100, account_id: acct, direction: 'expense', splits: [{ amount: 30, category_id: cat }, { amount: 30, category_id: cat }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /add up/);
  const ok = await client.post('/api/transactions', { amount: 60, account_id: acct, direction: 'expense', splits: [{ amount: 30, category_id: cat }, { amount: 30, category_id: cat }] });
  assert.equal(ok.status, 201);
});

test('fractional-cent money inputs are rejected before they can corrupt stored totals', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;

  // A sub-cent transaction amount is rejected up front — otherwise NUMERIC(16,2) would
  // silently round it on write, so the stored value wouldn't match what was validated.
  const subCent = await client.post('/api/transactions', { amount: 10.005, account_id: acct, direction: 'expense', txn_date: '2026-06-10' });
  assert.equal(subCent.status, 400);
  assert.match(subCent.body.error, /whole cents/);

  // The core regression: splits whose RAW float sum equals the total (3.335 + 6.665 = 10.00)
  // but whose per-row cent rounding would not (3.34 + 6.67 = 10.01). Must be rejected, not
  // persisted as a 10.01 breakdown under a 10.00 transaction.
  const badSplits = await client.post('/api/transactions', {
    amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-10',
    splits: [{ amount: 3.335, category_id: cat }, { amount: 6.665, category_id: cat }],
  });
  assert.equal(badSplits.status, 400);

  // Clean 2-decimal splits that sum exactly still post fine.
  const ok = await client.post('/api/transactions', {
    amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-10',
    splits: [{ amount: 3.33, category_id: cat }, { amount: 6.67, category_id: cat }],
  });
  assert.equal(ok.status, 201);
});

test('cross-book account/category references are rejected (404)', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acctA = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const catA = (await a.client.post('/api/categories', { name: 'A', kind: 'expense' })).body.id;
  const acctB = (await b.client.post('/api/accounts', { name: 'B', type: 'checking' })).body.id;
  const catB = (await b.client.post('/api/categories', { name: 'B', kind: 'expense' })).body.id;

  assert.equal((await a.client.post('/api/transactions', { amount: 5, account_id: acctB, direction: 'expense' })).status, 404);
  assert.equal((await a.client.post('/api/transactions', { amount: 5, account_id: acctA, category_id: catB })).status, 404);
  assert.equal((await a.client.post('/api/transactions', { amount: 6, account_id: acctA, direction: 'expense', splits: [{ amount: 6, category_id: catB }] })).status, 404);
  // sanity: A's own refs work
  assert.equal((await a.client.post('/api/transactions', { amount: 5, account_id: acctA, category_id: catA, direction: 'expense' })).status, 201);
  void acctB; void catA;
});

test('line tag targets must belong to the book', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acctA = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const vehA = (await a.client.post('/api/vehicles', { name: 'Car A' })).body.id;
  const vehB = (await b.client.post('/api/vehicles', { name: 'Car B' })).body.id;

  assert.equal((await a.client.post('/api/transactions', { amount: 10, account_id: acctA, direction: 'expense', tags: [{ kind: 'vehicle', ref_id: vehB }] })).status, 404);
  assert.equal((await a.client.post('/api/transactions', { amount: 10, account_id: acctA, direction: 'expense', tags: [{ kind: 'vehicle', ref_id: vehA }] })).status, 201);
});
