import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('paying a subscription twice for the same date is idempotent (no duplicate charge)', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Streaming', kind: 'expense' })).body.id;
  const sub = (await client.post('/api/subscriptions', { name: 'Netflix', amount: 15.99, billing_cycle: 'monthly', category_id: cat, account_id: acct })).body;

  const first = await client.post(`/api/subscriptions/${sub.id}/pay`, { txn_date: '2026-06-01' });
  assert.equal(first.status, 201);
  const second = await client.post(`/api/subscriptions/${sub.id}/pay`, { txn_date: '2026-06-01' });
  assert.equal(second.status, 201);

  // The second call returns the original transaction (no duplicate) and does NOT advance
  // the renewal date a second time.
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.transaction.id, first.body.transaction.id);
  assert.equal(second.body.subscription.next_due_date, first.body.subscription.next_due_date);
});

test('subscriptions are tracked as tags, not managed categories', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Streaming', kind: 'expense' })).body.id;
  const sub = (await client.post('/api/subscriptions', { name: 'Netflix', amount: 15.99, billing_cycle: 'monthly', category_id: cat, account_id: acct })).body;

  // No managed subscription category/group is created anymore.
  const cats = (await client.get('/api/categories')).body;
  assert.ok(!cats.some((c: any) => c.managed && c.source_kind === 'subscriptions'), 'no managed Subscriptions group');
  assert.ok(!cats.some((c: any) => c.managed && c.source_kind === 'subscription'), 'no managed subscription items');

  // Paying records the charge under the subscription's OWN category and tags it.
  const pay = await client.post(`/api/subscriptions/${sub.id}/pay`, { txn_date: '2026-06-01' });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.transaction.category_id, cat);

  // It shows in the subscription's charges (via the tag) and the transaction filter.
  let charges = (await client.get('/api/subscriptions/charges')).body;
  assert.equal(charges.length, 1);
  assert.equal(Number(charges[0].sub_id), sub.id);
  assert.equal(Number(charges[0].amount), 15.99);

  const filtered = (await client.get(`/api/transactions?subscription_id=${sub.id}`)).body;
  assert.equal([...filtered.posted, ...filtered.pending].length, 1);

  // A transaction manually tagged to the subscription also counts as a charge.
  await client.post('/api/transactions', { amount: 12.5, account_id: acct, direction: 'expense', category_id: cat, txn_date: '2026-05-01', tags: [{ kind: 'subscription', ref_id: sub.id }] });
  charges = (await client.get('/api/subscriptions/charges')).body;
  assert.equal(charges.length, 2);
});

test('per-subscription charges endpoint returns exact SQL total and count', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const sub = (await client.post('/api/subscriptions', { name: 'Spotify', amount: 9.99, billing_cycle: 'monthly', account_id: acct })).body;
  for (const [amt, d] of [[9.99, '2026-04-01'], [9.99, '2026-05-01'], [10.49, '2026-06-01']] as const) {
    await client.post('/api/transactions', { amount: amt, account_id: acct, direction: 'expense', txn_date: d, tags: [{ kind: 'subscription', ref_id: sub.id }] });
  }
  const r = await client.get(`/api/subscriptions/${sub.id}/charges`);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
  assert.equal(Number(Number(r.body.total).toFixed(2)), 30.47); // exact SQL SUM, not a capped client reduce
  assert.equal(r.body.charges.length, 3);

  // The endpoint is tenant-scoped: another book can't read this subscription's charges.
  const other = await registerUser(base);
  assert.equal((await other.client.get(`/api/subscriptions/${sub.id}/charges`)).status, 404);
});

test('a subscription tag must belong to the book', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acctA = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const subB = (await b.client.post('/api/subscriptions', { name: 'B-sub', amount: 5, billing_cycle: 'monthly' })).body.id;
  // A cannot tag a transaction to B's subscription.
  const r = await a.client.post('/api/transactions', { amount: 5, account_id: acctA, direction: 'expense', tags: [{ kind: 'subscription', ref_id: subB }] });
  assert.equal(r.status, 404);
});
