import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Stage a single-row CSV import into one account.
async function stage(client: any, acct: number, date: string, amount: number) {
  const r = await client.post('/api/imports', {
    text: `Date,Amount\n${date},${amount}`, account_id: acct, mapping: { date: 0, amount: 1 }, amountsNegativeAreExpense: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

test('opposite imported lines are detected and linked into one transfer', async () => {
  const { client } = await registerUser(base);
  const checking = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const card = (await client.post('/api/accounts', { name: 'Visa', type: 'savings' })).body.id;

  // A card payment: −$500 leaves checking, +$500 lands on the card, a day apart.
  await stage(client, checking, '2026-06-10', -500);
  await stage(client, card, '2026-06-11', 500);

  // Both sides are flagged as one transfer candidate.
  const pairs = (await client.get('/api/imports/staged/transfer-candidates')).body;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].out.account_id, checking, 'the money-out side is the source');
  assert.equal(pairs[0].in.account_id, card, 'the money-in side is the destination');

  // Linking creates ONE transfer row and clears both staged lines.
  const linked = await client.post('/api/imports/staged/transfer', { out_id: pairs[0].out.id, in_id: pairs[0].in.id });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.direction, 'transfer');
  assert.equal(linked.body.account_id, checking);
  assert.equal(linked.body.transfer_account_id, card);
  assert.equal(Number(linked.body.amount), 500);

  assert.equal((await client.get('/api/imports/staged')).body.length, 0, 'both staged rows were consumed');
  assert.equal((await client.get('/api/imports/staged/transfer-candidates')).body.length, 0);
});

test('a remembered rule auto-links matching pairs on later imports', async () => {
  const { client } = await registerUser(base);
  const checking = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const card = (await client.post('/api/accounts', { name: 'Visa', type: 'savings' })).body.id;

  // Link the first pair and remember the account pair.
  await stage(client, checking, '2026-06-10', -500);
  await stage(client, card, '2026-06-11', 500);
  const pairs = (await client.get('/api/imports/staged/transfer-candidates')).body;
  const linked = await client.post('/api/imports/staged/transfer', { out_id: pairs[0].out.id, in_id: pairs[0].in.id, remember: true });
  assert.equal(linked.status, 201);

  const rules = (await client.get('/api/imports/transfer-rules')).body;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source_account_id, checking);
  assert.equal(rules[0].dest_account_id, card);

  // A new matching pair should auto-link without manual review.
  await stage(client, checking, '2026-07-10', -300);
  await stage(client, card, '2026-07-11', 300);
  const auto = await client.post('/api/imports/staged/auto-link');
  assert.equal(auto.body.linked, 1, 'the rule auto-linked the new pair');
  assert.equal((await client.get('/api/imports/staged')).body.length, 0, 'nothing left to review');

  // Removing the rule stops auto-linking.
  await client.del(`/api/imports/transfer-rules/${rules[0].id}`);
  assert.equal((await client.get('/api/imports/transfer-rules')).body.length, 0);
  await stage(client, checking, '2026-08-10', -200);
  await stage(client, card, '2026-08-11', 200);
  assert.equal((await client.post('/api/imports/staged/auto-link')).body.linked, 0, 'no rule → no auto-link');
  assert.equal((await client.get('/api/imports/staged/transfer-candidates')).body.length, 1, 'pair waits for manual review');
});

test('non-matching imported lines are not offered as transfers', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const b = (await client.post('/api/accounts', { name: 'B', type: 'savings' })).body.id;

  // Same direction (both expenses) and mismatched amounts → no pair.
  await stage(client, a, '2026-06-10', -40);
  await stage(client, b, '2026-06-10', -90);
  assert.equal((await client.get('/api/imports/staged/transfer-candidates')).body.length, 0);
});
