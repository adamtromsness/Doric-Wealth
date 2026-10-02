import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const R = '/api/reconciliations';

// A checking account (opening 100) with two posted transactions and one pending.
async function setup() {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 100 })).body.id;
  const mk = (amount: number, direction: string, posted_date: string | null, extra: Record<string, unknown> = {}) =>
    client.post('/api/transactions', { amount, account_id: acct, direction, txn_date: '2026-09-05', posted_date, merchant: 'Shop', ...extra }).then((r: any) => r.body);
  const pay = await mk(500, 'income', '2026-09-06');
  const groceries = await mk(80.25, 'expense', '2026-09-07');
  const pending = await mk(20, 'expense', null);
  return { client, bookId, acct, pay, groceries, pending };
}

// Open a session for the account, clear the given transactions, and complete it.
async function reconcile(client: any, acct: number, txnIds: number[], statement_balance: number) {
  const s = (await client.post(R, { account_id: acct, statement_start: '2026-09-01', statement_end: '2026-09-30' })).body;
  for (const id of txnIds) assert.equal((await client.post(`${R}/${s.id}/items`, { transaction_id: id })).status, 201);
  const done = await client.put(`${R}/${s.id}`, { status: 'completed', statement_balance });
  return { s, done };
}

test('completion requires the cleared balance to match the statement', async () => {
  const { client, acct, pay, groceries } = await setup();
  const s = (await client.post(R, { account_id: acct, statement_end: '2026-09-30' })).body;
  assert.equal(Number(s.opening_balance), 100, 'opening defaults to the account opening balance');

  // The review's case: an arbitrary statement balance with nothing cleared.
  const bad = await client.put(`${R}/${s.id}`, { status: 'completed', statement_balance: 12345 });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /doesn't match/);
  assert.equal((await client.get(`${R}/${s.id}`)).body.status, 'open');

  // Missing statement end/balance → 400.
  const noEnd = (await client.post(R, { account_id: acct })).body;
  assert.equal((await client.put(`${R}/${noEnd.id}`, { status: 'completed' })).status, 400);

  // Clear both posted transactions: 100 + 500 - 80.25 = 519.75.
  await client.post(`${R}/${s.id}/items`, { transaction_id: pay.id });
  await client.post(`${R}/${s.id}/items`, { transaction_id: groceries.id });
  const live = (await client.get(`${R}/${s.id}`)).body;
  assert.equal(live.cleared_balance, 519.75);
  assert.equal(live.difference, null, 'the rejected completion rolled back its statement balance too');
  const withStmt = (await client.put(`${R}/${s.id}`, { statement_balance: 520 })).body;
  assert.equal(withStmt.difference, 0.25);

  const ok = await client.put(`${R}/${s.id}`, { status: 'completed', statement_balance: 519.75 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'completed');
  assert.equal(Number(ok.body.cleared_balance), 519.75);
  assert.equal(ok.body.difference, 0);

  // Evidence is frozen on the items.
  const items = (await client.get(`${R}/${s.id}/items`)).body;
  assert.deepEqual(items.map((i: any) => Number(i.frozen_delta)).sort((a: number, b: number) => a - b), [-80.25, 500]);
  assert.ok(items.every((i: any) => i.frozen_posted_date));

  const events = (await client.get(`${R}/${s.id}/events`)).body.map((e: any) => e.action);
  assert.deepEqual(events, ['created', 'completed']);
});

test('a completed session is frozen: no item changes, statement edits, or cancel until reopened', async () => {
  const { client, acct, pay, groceries } = await setup();
  const { s, done } = await reconcile(client, acct, [pay.id], 600);
  assert.equal(done.status, 200);

  // The review's case: adding an item after completion.
  assert.equal((await client.post(`${R}/${s.id}/items`, { transaction_id: groceries.id })).status, 409);
  const item = (await client.get(`${R}/${s.id}/items`)).body[0];
  assert.equal((await client.del(`${R}/${s.id}/items/${item.id}`)).status, 409);
  assert.equal((await client.put(`${R}/${s.id}`, { statement_balance: 1 })).status, 409);
  assert.equal((await client.put(`${R}/${s.id}`, { status: 'canceled' })).status, 409);

  // Explicit reopen (audited) unlocks it and clears the frozen figures.
  const reopened = await client.put(`${R}/${s.id}`, { status: 'open' });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.cleared_balance, 600, 'live figure after reopening');
  assert.equal((await client.get(`${R}/${s.id}/items`)).body[0].frozen_delta, null);
  assert.equal((await client.post(`${R}/${s.id}/items`, { transaction_id: groceries.id })).status, 201);
  assert.deepEqual((await client.get(`${R}/${s.id}/events`)).body.map((e: any) => e.action), ['created', 'completed', 'reopened']);
});

test('reconciled transactions: amounts, dates, accounts, and deletion are guarded; other fields stay editable', async () => {
  const { client, acct, pay } = await setup();
  const { s } = await reconcile(client, acct, [pay.id], 600);
  const base = { account_id: acct, direction: 'income', txn_date: '2026-09-05', posted_date: '2026-09-06' };

  const amt = await client.put(`/api/transactions/${pay.id}`, { ...base, amount: 501 });
  assert.equal(amt.status, 409);
  assert.match(amt.body.error, /completed reconciliation/);
  assert.equal((await client.put(`/api/transactions/${pay.id}`, { ...base, amount: 500, posted_date: '2026-09-08' })).status, 409);
  assert.equal((await client.del(`/api/transactions/${pay.id}`)).status, 409);

  // Merchant / description edits are fine.
  const ok = await client.put(`/api/transactions/${pay.id}`, { ...base, amount: 500, merchant: 'Employer', description: 'Paycheck' });
  assert.equal(ok.status, 200);

  // Converting it into a transfer (deletes it) is refused too.
  const savings = (await client.post('/api/accounts', { name: 'Savings', type: 'savings', opening_balance: 0 })).body.id;
  const out = (await client.post('/api/transactions', { amount: 500, account_id: savings, direction: 'expense', txn_date: '2026-09-05', posted_date: '2026-09-06' })).body;
  assert.equal((await client.post('/api/transactions/transfer-suggestions/confirm', { out_id: out.id, in_id: pay.id })).status, 409);

  // After reopening, the transaction can change again.
  await client.put(`${R}/${s.id}`, { status: 'open' });
  assert.equal((await client.put(`/api/transactions/${pay.id}`, { ...base, amount: 501 })).status, 200);
});

test('only posted transactions can be cleared, and not twice for the same account', async () => {
  const { client, acct, pay, pending } = await setup();
  const s = (await client.post(R, { account_id: acct, statement_end: '2026-09-30' })).body;
  const p = await client.post(`${R}/${s.id}/items`, { transaction_id: pending.id });
  assert.equal(p.status, 400);
  assert.match(p.body.error, /pending/);
  // Marking a pending one NOT cleared is fine (it's tracked, not counted).
  assert.equal((await client.post(`${R}/${s.id}/items`, { transaction_id: pending.id, cleared: false })).status, 201);

  await reconcile(client, acct, [pay.id], 600);
  const s2 = (await client.post(R, { account_id: acct, statement_end: '2026-10-31' })).body;
  assert.equal(Number(s2.opening_balance), 600, 'opening defaults to the previous completed statement balance');
  assert.equal((await client.post(`${R}/${s2.id}/items`, { transaction_id: pay.id })).status, 409);
});

test('liability accounts reconcile with balances running the other way', async () => {
  const { client } = await registerUser(base);
  const card = (await client.post('/api/accounts', { name: 'Visa', type: 'credit_card', is_liability: true, opening_balance: 200 })).body.id;
  const charge = (await client.post('/api/transactions', { amount: 50, account_id: card, direction: 'expense', txn_date: '2026-09-03', posted_date: '2026-09-03' })).body;
  const { done } = await reconcile(client, card, [charge.id], 250);
  assert.equal(done.status, 200, 'owed 200 + charge 50 = 250');
});

test('deleting a whole book still works with completed reconciliations (cascade is allowed)', async () => {
  const { client, bookId, acct, pay } = await setup();
  await reconcile(client, acct, [pay.id], 600);
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`DELETE FROM books WHERE id = $1`, [bookId]);
    assert.equal((await db.query(`SELECT count(*)::int AS c FROM transactions WHERE book_id = $1`, [bookId])).rows[0].c, 0);
  } finally {
    await db.end();
  }
});

test('a book with a completed reconciliation can be backed up and restored', async () => {
  const { client, acct, pay } = await setup();
  await reconcile(client, acct, [pay.id], 600);
  const snap = (await client.post('/api/backup/snapshots', { name: 'Before restore' })).body;
  const restored = await client.post(`/api/backup/snapshots/${snap.id}/restore`, { confirm: 'REPLACE' });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const sessions = (await client.get(`${R}?account_id=`)).body;
  assert.equal(sessions.filter((x: any) => x.status === 'completed').length, 1);
});
