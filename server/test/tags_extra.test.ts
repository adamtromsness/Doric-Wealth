import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('GET /tags lists the book\'s tags with a txn_count', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/tags', { name: 'Groceries' });
  const list = (await client.get('/api/tags')).body;
  assert.ok(Array.isArray(list));
  const g = list.find((t: any) => t.name === 'Groceries');
  assert.ok(g);
  assert.equal(g.txn_count, 0, 'a fresh tag has no transactions');
  assert.equal(g.archived, false);
});

test('POST /tags validates the name and rejects duplicates', async () => {
  const { client } = await registerUser(base);
  // Missing name → 400 (require_).
  assert.equal((await client.post('/api/tags', {})).status, 400);
  // Blank name → 400.
  const blank = await client.post('/api/tags', { name: '   ' });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /tag name is required/i);

  const created = await client.post('/api/tags', { name: 'Travel', description: '  trips  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, 'trips', 'description is trimmed');

  // Duplicate name → 409.
  const dup = await client.post('/api/tags', { name: 'Travel' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already exists/i);
});

test('PUT /tags/:id updates name/archived/description with the right semantics', async () => {
  const { client } = await registerUser(base);
  const id = (await client.post('/api/tags', { name: 'Dining', description: 'eats' })).body.id;

  // Blank name → 400 (explicit empty string).
  assert.equal((await client.put(`/api/tags/${id}`, { name: '' })).status, 400);

  // Rename + archive.
  const upd = await client.put(`/api/tags/${id}`, { name: 'Eating Out', archived: true });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Eating Out');
  assert.equal(upd.body.archived, true);
  assert.equal(upd.body.description, 'eats', 'description unchanged when key absent');

  // Present empty description → cleared to null.
  const cleared = await client.put(`/api/tags/${id}`, { description: '' });
  assert.equal(cleared.body.description, null);

  // Present non-empty description → set.
  const setDesc = await client.put(`/api/tags/${id}`, { description: 'meals out' });
  assert.equal(setDesc.body.description, 'meals out');

  // Missing tag → 404.
  assert.equal((await client.put('/api/tags/999999', { name: 'X' })).status, 404);
});

test('PUT /tags/:id rejects a rename that collides with another tag (409)', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/tags', { name: 'Alpha' });
  const beta = (await client.post('/api/tags', { name: 'Beta' })).body.id;
  const dup = await client.put(`/api/tags/${beta}`, { name: 'Alpha' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already exists/i);
});

test('GET /tags/:id/report returns 404 for a missing/other-book tag', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.get('/api/tags/999999/report')).status, 404);

  // Another book cannot report on this book's tag.
  const tag = (await client.post('/api/tags', { name: 'Private' })).body.id;
  const other = await registerUser(base);
  assert.equal((await other.client.get(`/api/tags/${tag}/report`)).status, 404);
});

test('GET /tags/:id/report aggregates by category and month across income+expense', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Fun' })).body.id;
  const tag = (await client.post('/api/tags', { name: 'Vacation' })).body.id;
  const tags = [{ kind: 'tag', ref_id: tag }];

  await client.post('/api/transactions', { amount: 100, account_id: acct, direction: 'expense', category_id: cat, txn_date: '2026-01-10', tags });
  await client.post('/api/transactions', { amount: 40, account_id: acct, direction: 'income', txn_date: '2026-02-10', tags });

  const rep = (await client.get(`/api/tags/${tag}/report`)).body;
  assert.equal(Number(rep.totals.expense), 100);
  assert.equal(Number(rep.totals.income), 40);
  assert.ok(rep.byCategory.some((c: any) => c.category_name === 'Fun'), 'category breakdown present');
  assert.equal(rep.byMonth.length, 2, 'a monthly bucket per activity month');
  assert.equal(rep.transactions_total, 2);
});
