import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('POST /reconciliations validates account_id and ownership', async () => {
  const { client } = await registerUser(base);
  // Missing account_id → 400.
  assert.equal((await client.post('/api/reconciliations', {})).status, 400);
  // Non-positive account_id → 400.
  assert.equal((await client.post('/api/reconciliations', { account_id: 0 })).status, 400);

  // An account in ANOTHER book → 404 (assertOwned).
  const other = await registerUser(base);
  const otherAcct = (await other.client.post('/api/accounts', { name: 'X', type: 'checking' })).body.id;
  assert.equal((await client.post('/api/reconciliations', { account_id: otherAcct })).status, 404);
});

test('POST /reconciliations creates a session with statement fields', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const created = await client.post('/api/reconciliations', {
    account_id: acct, statement_start: '2026-01-01', statement_end: '2026-01-31', statement_balance: 12345,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.account_id, acct);
  assert.equal(created.body.status, 'open');
  assert.equal(Number(created.body.statement_balance), 12345);
});

test('GET /reconciliations lists sessions and filters by account_id', async () => {
  const { client } = await registerUser(base);
  const a1 = (await client.post('/api/accounts', { name: 'A1', type: 'checking' })).body.id;
  const a2 = (await client.post('/api/accounts', { name: 'A2', type: 'savings' })).body.id;
  const s1 = (await client.post('/api/reconciliations', { account_id: a1 })).body;
  const s2 = (await client.post('/api/reconciliations', { account_id: a2 })).body;

  const all = (await client.get('/api/reconciliations')).body;
  assert.ok(all.some((s: any) => s.id === s1.id) && all.some((s: any) => s.id === s2.id));

  const filtered = (await client.get(`/api/reconciliations?account_id=${a1}`)).body;
  assert.ok(filtered.every((s: any) => s.account_id === a1));
  assert.ok(filtered.some((s: any) => s.id === s1.id));
  assert.ok(!filtered.some((s: any) => s.id === s2.id));
});

test('GET /reconciliations/:id returns the session or 404', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const s = (await client.post('/api/reconciliations', { account_id: acct })).body;
  assert.equal((await client.get(`/api/reconciliations/${s.id}`)).body.id, s.id);
  // Missing session → 404.
  assert.equal((await client.get('/api/reconciliations/999999')).status, 404);
  // Cross-book → 404.
  const other = await registerUser(base);
  assert.equal((await other.client.get(`/api/reconciliations/${s.id}`)).status, 404);
});

test('PUT /reconciliations/:id: status transitions stamp/clear completed_at; bad enum 400', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const s = (await client.post('/api/reconciliations', { account_id: acct })).body;

  // Invalid status → 400.
  assert.equal((await client.put(`/api/reconciliations/${s.id}`, { status: 'bogus' })).status, 400);

  // Complete (statement matches: nothing cleared, opening 0) → completed_at stamped.
  const completed = (await client.put(`/api/reconciliations/${s.id}`, { status: 'completed', statement_balance: 0, statement_end: '2026-06-30' })).body;
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completed_at, 'completing stamps completed_at');
  assert.equal(Number(completed.statement_balance), 0);

  // Reopen → completed_at cleared.
  const reopened = (await client.put(`/api/reconciliations/${s.id}`, { status: 'open' })).body;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.completed_at, null, 'reopening clears completed_at');

  // Cancel → completed_at stays null.
  const canceled = (await client.put(`/api/reconciliations/${s.id}`, { status: 'canceled' })).body;
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.completed_at, null);

  // PUT on a missing session → 404 (ownedSession).
  assert.equal((await client.put('/api/reconciliations/999999', { status: 'open' })).status, 404);
});

test('reconciliation items: list, idempotent clear toggle, delete, and 404 guards', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const session = (await client.post('/api/reconciliations', { account_id: acct })).body;
  const txn = (await client.post('/api/transactions', { amount: 100, account_id: acct, direction: 'expense', txn_date: '2026-06-01' })).body;

  // Missing transaction_id → 400.
  assert.equal((await client.post(`/api/reconciliations/${session.id}/items`, {})).status, 400);
  // Unknown transaction in this book → 404.
  assert.equal((await client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: 999999 })).status, 404);

  // Clear it (default cleared = true).
  const item = (await client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: txn.id })).body;
  assert.equal(item.cleared, true);

  // Idempotent upsert: same txn again with cleared:false flips the flag, no duplicate.
  const toggled = (await client.post(`/api/reconciliations/${session.id}/items`, { transaction_id: txn.id, cleared: false })).body;
  assert.equal(toggled.id, item.id, 'same item row (upsert on session+transaction)');
  assert.equal(toggled.cleared, false);

  // List shows the item joined to the transaction.
  const items = (await client.get(`/api/reconciliations/${session.id}/items`)).body;
  assert.equal(items.length, 1);
  assert.equal(items[0].transaction_id, txn.id);
  assert.equal(items[0].txn_date, '2026-06-01');

  // Delete the item.
  assert.equal((await client.del(`/api/reconciliations/${session.id}/items/${item.id}`)).status, 204);
  assert.equal((await client.get(`/api/reconciliations/${session.id}/items`)).body.length, 0);

  // Items endpoints on a missing session → 404.
  assert.equal((await client.get('/api/reconciliations/999999/items')).status, 404);
  assert.equal((await client.post('/api/reconciliations/999999/items', { transaction_id: txn.id })).status, 404);
  assert.equal((await client.del('/api/reconciliations/999999/items/1')).status, 404);
});
