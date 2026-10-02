import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const mkTxn = (client: any, account_id: number, direction: string, amount: number, txn_date: string) =>
  client.post('/api/transactions', { amount, account_id, direction, txn_date });

test('posted opposite transactions are suggested and convert into one transfer', async () => {
  const { client } = await registerUser(base);
  const checking = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const card = (await client.post('/api/accounts', { name: 'Visa', type: 'savings' })).body.id;

  // Manually entered: a $500 expense from checking and a $500 income on the card.
  const exp = await mkTxn(client, checking, 'expense', 500, '2026-06-10');
  const inc = await mkTxn(client, card, 'income', 500, '2026-06-11');
  assert.equal(exp.status, 201);
  assert.equal(inc.status, 201);

  // The finder surfaces the pair.
  const sugg = (await client.get('/api/transactions/transfer-suggestions')).body;
  assert.equal(sugg.length, 1);
  assert.equal(sugg[0].out.account_id, checking);
  assert.equal(sugg[0].in.account_id, card);
  assert.equal(sugg[0].amount, 500);

  // Converting replaces both with one transfer.
  const conv = await client.post('/api/transactions/transfer-suggestions/confirm', { out_id: sugg[0].out.id, in_id: sugg[0].in.id });
  assert.equal(conv.status, 201);
  assert.equal(conv.body.direction, 'transfer');
  assert.equal(conv.body.account_id, checking);
  assert.equal(conv.body.transfer_account_id, card);
  assert.equal(Number(conv.body.amount), 500);

  // No suggestions remain — the two postings were consumed into the transfer.
  assert.equal((await client.get('/api/transactions/transfer-suggestions')).body.length, 0);
});

test('dismissing a transfer suggestion stops it re-surfacing', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const b = (await client.post('/api/accounts', { name: 'B', type: 'savings' })).body.id;
  await mkTxn(client, a, 'expense', 75, '2026-06-10');
  await mkTxn(client, b, 'income', 75, '2026-06-10');

  const sugg = (await client.get('/api/transactions/transfer-suggestions')).body;
  assert.equal(sugg.length, 1);
  await client.post('/api/transactions/transfer-suggestions/ignore', { out_id: sugg[0].out.id, in_id: sugg[0].in.id });
  assert.equal((await client.get('/api/transactions/transfer-suggestions')).body.length, 0, 'dismissed pair no longer suggested');
});

test('simultaneous confirmations of the same pair create exactly one transfer', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 0 })).body.id;
  const b = (await client.post('/api/accounts', { name: 'Savings', type: 'savings', opening_balance: 0 })).body.id;
  const out = (await client.post('/api/transactions', { amount: 250, account_id: a, direction: 'expense', txn_date: '2026-09-10', posted_date: '2026-09-10' })).body;
  const inn = (await client.post('/api/transactions', { amount: 250, account_id: b, direction: 'income', txn_date: '2026-09-10', posted_date: '2026-09-10' })).body;

  const results = await Promise.all([1, 2, 3].map(() =>
    client.post('/api/transactions/transfer-suggestions/confirm', { out_id: out.id, in_id: inn.id })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409]);

  const listed = (await client.get('/api/transactions?limit=100')).body;
  const all = [...listed.posted, ...listed.pending];
  assert.equal(all.filter((t: any) => t.direction === 'transfer').length, 1, 'one transfer');
  assert.equal(all.length, 1, 'the two originals are gone');
});

test('simultaneous confirmations of two pairs sharing a transaction: only one wins', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 0 })).body.id;
  const b = (await client.post('/api/accounts', { name: 'Savings', type: 'savings', opening_balance: 0 })).body.id;
  const c = (await client.post('/api/accounts', { name: 'Brokerage', type: 'brokerage', opening_balance: 0 })).body.id;
  const out = (await client.post('/api/transactions', { amount: 75, account_id: a, direction: 'expense', txn_date: '2026-09-10', posted_date: '2026-09-10' })).body;
  const in1 = (await client.post('/api/transactions', { amount: 75, account_id: b, direction: 'income', txn_date: '2026-09-10', posted_date: '2026-09-10' })).body;
  const in2 = (await client.post('/api/transactions', { amount: 75, account_id: c, direction: 'income', txn_date: '2026-09-10', posted_date: '2026-09-10' })).body;

  const [r1, r2] = await Promise.all([
    client.post('/api/transactions/transfer-suggestions/confirm', { out_id: out.id, in_id: in1.id }),
    client.post('/api/transactions/transfer-suggestions/confirm', { out_id: out.id, in_id: in2.id }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);

  const listed = (await client.get('/api/transactions?limit=100')).body;
  const all = [...listed.posted, ...listed.pending];
  assert.equal(all.filter((t: any) => t.direction === 'transfer').length, 1);
  assert.equal(all.filter((t: any) => t.direction === 'income').length, 1, 'the losing income is untouched');
});
