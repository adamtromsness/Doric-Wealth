import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const setupItem = (body: any, key: string) => body.setup.find((s: any) => s.key === key);

test('fresh book: all setup items open, none done, no attention items', async () => {
  const { client } = await registerUser(base);
  const r = await client.get('/api/todos');
  assert.equal(r.status, 200);

  // Seven setup items, all present and not done.
  assert.equal(r.body.setup.length, 7);
  for (const s of r.body.setup) assert.equal(s.done, false, `${s.key} should start undone`);
  assert.equal(r.body.setupOpen, 7);

  // The two non-dismissible foundation items.
  assert.equal(setupItem(r.body, 'account').dismissible, false);
  assert.equal(setupItem(r.body, 'transactions').dismissible, false);

  // Nothing needs attention yet.
  assert.deepEqual(r.body.attention, []);
  assert.equal(r.body.attentionCount, 0);
});

test('setup items flip to done as the underlying data is created', async () => {
  const { client } = await registerUser(base);

  // account
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  assert.equal(setupItem((await client.get('/api/todos')).body, 'account').done, true);

  // transactions (categorized so it doesn't also create an attention item)
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-01', category_id: cat });
  assert.equal(setupItem((await client.get('/api/todos')).body, 'transactions').done, true);

  // assets (an owned asset counts)
  await client.post('/api/assets', { name: 'Boat', asset_type: 'boat', value: 5000 });
  assert.equal(setupItem((await client.get('/api/todos')).body, 'assets').done, true);

  // plan (a budget OR a goal)
  await client.post('/api/goals', { name: 'Save', goal_type: 'savings', target_amount: 100 });
  assert.equal(setupItem((await client.get('/api/todos')).body, 'plan').done, true);

  // tags
  await client.post('/api/tags', { name: 'Vacation' });
  assert.equal(setupItem((await client.get('/api/todos')).body, 'tags').done, true);

  // ai_key (set via auth/ai-settings)
  await client.put('/api/auth/ai-settings', { api_key: 'sk-test-key-123' });
  assert.equal(setupItem((await client.get('/api/todos')).body, 'ai_key').done, true);

  // Now only 'bank' (connect a bank) remains open of the dismissible items.
  const r = await client.get('/api/todos');
  assert.equal(setupItem(r.body, 'bank').done, false);
  assert.equal(r.body.setupOpen, 1);
});

test('uncategorized expenses surface as a Needs-attention item; a transfer never does', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const acct2 = (await client.post('/api/accounts', { name: 'Savings', type: 'savings' })).body.id;

  // Two uncategorized expenses.
  await client.post('/api/transactions', { amount: 12, account_id: acct, direction: 'expense', txn_date: '2026-06-01' });
  await client.post('/api/transactions', { amount: 8, account_id: acct, direction: 'expense', txn_date: '2026-06-02' });
  // A transfer (direction=transfer) is excluded from the uncategorized count.
  await client.post('/api/transactions', { amount: 100, account_id: acct, transfer_account_id: acct2, direction: 'transfer', txn_date: '2026-06-03' });

  const r = await client.get('/api/todos');
  const item = r.body.attention.find((a: any) => a.kind === 'uncategorized');
  assert.ok(item, 'an uncategorized attention item exists');
  assert.equal(item.count, 2);
  assert.equal(item.severity, 'warn');
  assert.match(item.title, /Categorize 2 transactions/);
  assert.equal(r.body.attentionCount, r.body.attention.length);

  // A transaction split with a category clears the parent from the count.
  const foodCat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  const uncats = (await client.get('/api/transactions?uncategorized=1')).body;
  const one = [...uncats.posted, ...uncats.pending][0];
  await client.put(`/api/transactions/${one.id}`, {
    amount: one.amount, splits: [{ amount: one.amount, category_id: foodCat }],
  });
  const after = await client.get('/api/todos');
  const item2 = after.body.attention.find((a: any) => a.kind === 'uncategorized');
  assert.equal(item2.count, 1, 'the split-categorized transaction no longer counts');
});

test('singular vs plural title: a single uncategorized transaction reads "transaction"', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  await client.post('/api/transactions', { amount: 5, account_id: acct, direction: 'expense', txn_date: '2026-06-01' });
  const r = await client.get('/api/todos');
  const item = r.body.attention.find((a: any) => a.kind === 'uncategorized');
  assert.equal(item.count, 1);
  assert.match(item.title, /Categorize 1 transaction\b/);
  assert.doesNotMatch(item.title, /transactions/);
});

test('dismiss / undismiss an optional setup item', async () => {
  const { client } = await registerUser(base);

  // Dismiss the "bank" item → it's marked dismissed and drops out of setupOpen.
  assert.equal((await client.post('/api/todos/dismiss', { key: 'bank' })).body.ok, true);
  let r = await client.get('/api/todos');
  assert.equal(setupItem(r.body, 'bank').dismissed, true);
  const openWithBankDismissed = r.body.setupOpen;

  // Dismissing again is idempotent (DISTINCT array_agg) — still one dismissal.
  await client.post('/api/todos/dismiss', { key: 'bank' });
  r = await client.get('/api/todos');
  assert.equal(setupItem(r.body, 'bank').dismissed, true);
  assert.equal(r.body.setupOpen, openWithBankDismissed);

  // Undismiss restores it.
  assert.equal((await client.post('/api/todos/undismiss', { key: 'bank' })).body.ok, true);
  r = await client.get('/api/todos');
  assert.equal(setupItem(r.body, 'bank').dismissed, false);

  // Undismiss when there's nothing dismissed → COALESCE to '[]' (no error).
  assert.equal((await client.post('/api/todos/undismiss', { key: 'tags' })).body.ok, true);
});

test('dismiss / undismiss require a non-blank key (400)', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/todos/dismiss', {})).status, 400);
  assert.equal((await client.post('/api/todos/dismiss', { key: '   ' })).status, 400);
  assert.equal((await client.post('/api/todos/undismiss', {})).status, 400);
  assert.equal((await client.post('/api/todos/undismiss', { key: '' })).status, 400);
});

test('todos are book-scoped: one book\'s data never flips another book\'s setup', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);

  // A creates an account; B's checklist is unaffected.
  await a.client.post('/api/accounts', { name: 'A checking', type: 'checking' });
  assert.equal(setupItem((await b.client.get('/api/todos')).body, 'account').done, false);
  assert.equal(setupItem((await a.client.get('/api/todos')).body, 'account').done, true);

  // A dismisses "bank"; B's "bank" stays not-dismissed.
  await a.client.post('/api/todos/dismiss', { key: 'bank' });
  assert.equal(setupItem((await b.client.get('/api/todos')).body, 'bank').dismissed, false);
  assert.equal(setupItem((await a.client.get('/api/todos')).body, 'bank').dismissed, true);
});

// The import/connection Needs-attention items (review / unmapped / sync_error) come
// from a live SimpleFIN link and have no create-them-via-API path, so they're seeded
// directly. A connection also satisfies the "bank" setup item.
test('staged imports, unmapped bank accounts, and sync errors raise attention items', async () => {
  const { client, bookId } = await registerUser(base);
  const db = testDbClient();
  await db.connect();
  try {
    // Scope this session to the book so RLS lets the inserts through.
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);

    // An errored connection: satisfies "bank" and raises a sync_error.
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', 'enc', 'error') RETURNING id`,
      [bookId]
    )).rows[0].id;

    // An unmapped external account (account_id IS NULL).
    await db.query(
      `INSERT INTO account_links (book_id, link_id, external_account_id, account_id, org_name)
       VALUES ($1, $2, 'ext-1', NULL, 'Some Bank')`,
      [bookId, link]
    );

    // A staged transaction awaiting review (decision = 'import').
    const batch = (await db.query(
      `INSERT INTO import_batches (book_id, source) VALUES ($1, 'csv') RETURNING id`,
      [bookId]
    )).rows[0].id;
    await db.query(
      `INSERT INTO staged_transactions (book_id, batch_id, amount, direction, decision)
       VALUES ($1, $2, 12.34, 'expense', 'import')`,
      [bookId, batch]
    );
  } finally {
    await db.end();
  }

  const body = (await client.get('/api/todos')).body;
  const kinds = body.attention.map((a: any) => a.kind).sort();
  assert.deepEqual(kinds, ['review', 'sync_error', 'unmapped']);
  assert.equal(body.attention.find((a: any) => a.kind === 'review').count, 1);
  assert.equal(body.attention.find((a: any) => a.kind === 'unmapped').count, 1);
  assert.equal(body.attention.find((a: any) => a.kind === 'sync_error').severity, 'debit');
  assert.equal(body.attentionCount, 3);
  // The connection satisfies the "bank" setup item.
  assert.equal(setupItem(body, 'bank').done, true);
});
