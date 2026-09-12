import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('budget CRUD: list, create validation, custom-range checks, delete', async () => {
  const { client } = await registerUser(base);
  // name required.
  assert.equal((await client.post('/api/budgets', {})).status, 400);
  // bad period enum → 400.
  assert.equal((await client.post('/api/budgets', { name: 'B', period: 'fortnightly' })).status, 400);
  // custom without dates → 400.
  assert.equal((await client.post('/api/budgets', { name: 'C', period: 'custom' })).status, 400);
  // custom end before start → 400.
  assert.equal((await client.post('/api/budgets', { name: 'C', period: 'custom', start_date: '2026-06-30', end_date: '2026-06-01' })).status, 400);

  // Defaults to monthly.
  const b = await client.post('/api/budgets', { name: 'Monthly One' });
  assert.equal(b.status, 201);
  assert.equal(b.body.period, 'monthly');

  const list = (await client.get('/api/budgets')).body as any[];
  assert.ok(list.some((x) => x.id === b.body.id));

  // Delete.
  assert.equal((await client.del(`/api/budgets/${b.body.id}`)).status, 204);
  assert.ok(!((await client.get('/api/budgets')).body as any[]).some((x) => x.id === b.body.id));
});

test('budget lines: get, upsert on conflict, validation, delete, 404 scoping', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  const bud = (await client.post('/api/budgets', { name: 'B', period: 'monthly' })).body.id;

  // Lines of a missing budget → 404.
  assert.equal((await client.get('/api/budgets/999999/lines')).status, 404);
  // Adding a line to a missing budget → 404.
  assert.equal((await client.post('/api/budgets/999999/lines', { category_id: cat, amount: 10 })).status, 404);
  // Missing category_id → 400.
  assert.equal((await client.post(`/api/budgets/${bud}/lines`, { amount: 10 })).status, 400);
  // Missing amount → 400.
  assert.equal((await client.post(`/api/budgets/${bud}/lines`, { category_id: cat })).status, 400);

  // Create a line with a rollover mode + opening balance.
  const line = await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 100, rollover_mode: 'carryover', opening_balance: 25 });
  assert.equal(line.status, 201);
  assert.equal(Number(line.body.amount), 100);
  assert.equal(Number(line.body.opening_balance), 25);

  // Upsert (same category) updates amount but preserves opening_balance when omitted.
  const upsert = await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 150 });
  assert.equal(upsert.status, 201);
  assert.equal(Number(upsert.body.amount), 150);
  assert.equal(Number(upsert.body.opening_balance), 25, 'opening_balance preserved on inline amount edit');

  // List returns the line with category name + kind.
  const lines = (await client.get(`/api/budgets/${bud}/lines`)).body as any[];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].category_name, 'Food');

  // Delete the line.
  assert.equal((await client.del(`/api/budgets/${bud}/lines/${line.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/budgets/${bud}/lines`)).body.length, 0);
});

test('budget periods: freeze snapshot, list, and validation', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Groceries', kind: 'expense' })).body.id;
  const bud = (await client.post('/api/budgets', { name: 'B', period: 'monthly' })).body.id;
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 200 });

  // Missing period_start → 400.
  assert.equal((await client.post(`/api/budgets/${bud}/periods`, { period_end: '2026-06-30' })).status, 400);
  // period_end before period_start → 400.
  assert.equal((await client.post(`/api/budgets/${bud}/periods`, { period_start: '2026-06-30', period_end: '2026-06-01' })).status, 400);
  // Period ops on a missing budget → 404.
  assert.equal((await client.get('/api/budgets/999999/periods')).status, 404);

  // Freeze the June period.
  const frozen = await client.post(`/api/budgets/${bud}/periods`, { period_start: '2026-06-01', period_end: '2026-06-30' });
  assert.equal(frozen.status, 201);
  assert.equal(frozen.body.status, 'closed');

  // Re-freezing the same window upserts (still one period listed).
  assert.equal((await client.post(`/api/budgets/${bud}/periods`, { period_start: '2026-06-01', period_end: '2026-06-30' })).status, 201);
  const periods = (await client.get(`/api/budgets/${bud}/periods`)).body as any[];
  assert.equal(periods.length, 1);
});

test('budget transactions endpoint: section vs uncategorized scope, filters, pagination', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Dining', kind: 'expense' })).body.id;
  const other = (await client.post('/api/categories', { name: 'Misc', kind: 'expense' })).body.id;
  const bud = (await client.post('/api/budgets', { name: 'B', period: 'monthly' })).body.id;
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 300 });

  const now = new Date();
  const ymd = (d: number) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ref = ymd(15);
  // A budgeted-category expense and an un-budgeted-category expense in this window.
  await client.post('/api/transactions', { amount: 40, account_id: acct, category_id: cat, direction: 'expense', txn_date: ymd(2), posted_date: ymd(2) });
  await client.post('/api/transactions', { amount: 25, account_id: acct, category_id: other, direction: 'expense', txn_date: ymd(3), posted_date: ymd(3) });

  // 404 for a missing budget.
  assert.equal((await client.get('/api/budgets/999999/transactions')).status, 404);

  // scope=section: only budgeted categories.
  const section = (await client.get(`/api/budgets/${bud}/transactions?scope=section&kind=expense&ref=${ref}`)).body;
  assert.equal(section.total, 1);
  assert.equal(Number(section.transactions[0].amount), 40);

  // scope=uncategorized: everything NOT in a budgeted category.
  const uncat = (await client.get(`/api/budgets/${bud}/transactions?scope=uncategorized&kind=expense&ref=${ref}`)).body;
  assert.equal(uncat.total, 1);
  assert.equal(Number(uncat.transactions[0].amount), 25);

  // Explicit cats filter (clicking a line's spent figure).
  const byCat = (await client.get(`/api/budgets/${bud}/transactions?cats=${cat}&kind=expense&ref=${ref}`)).body;
  assert.equal(byCat.total, 1);

  // Pagination: limit=1 returns one row but the full count.
  const paged = (await client.get(`/api/budgets/${bud}/transactions?scope=uncategorized&kind=expense&ref=${ref}&limit=1&offset=0`)).body;
  assert.equal(paged.transactions.length, 1);

  // income kind returns no expense rows.
  const income = (await client.get(`/api/budgets/${bud}/transactions?scope=section&kind=income&ref=${ref}`)).body;
  assert.equal(income.total, 0);
});

test('progress across weekly and yearly period windows', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Coffee', kind: 'expense' })).body.id;

  // Weekly budget → window is a Mon–Sun week; bucket is 'day'.
  const weekly = (await client.post('/api/budgets', { name: 'W', period: 'weekly' })).body.id;
  await client.post(`/api/budgets/${weekly}/lines`, { category_id: cat, amount: 50 });
  await client.post('/api/transactions', { amount: 12, account_id: acct, category_id: cat, direction: 'expense', txn_date: '2026-06-10', posted_date: '2026-06-10' });
  const wProg = (await client.get(`/api/budgets/${weekly}/progress?ref=2026-06-10`)).body;
  assert.match(wProg.window.label, /^Week of /);
  assert.equal(wProg.bucket, 'day');

  // Yearly budget → window is Jan 1–Dec 31; bucket is 'week'.
  const yearly = (await client.post('/api/budgets', { name: 'Y', period: 'yearly' })).body.id;
  await client.post(`/api/budgets/${yearly}/lines`, { category_id: cat, amount: 600 });
  const yProg = (await client.get(`/api/budgets/${yearly}/progress?ref=2026-06-10`)).body;
  assert.equal(yProg.window.start, '2026-01-01');
  assert.equal(yProg.window.end, '2026-12-31');
  assert.equal(yProg.window.label, '2026');
  assert.equal(yProg.bucket, 'week');

  // 404 progress on a missing budget.
  assert.equal((await client.get('/api/budgets/999999/progress')).status, 404);
});

test('budget lines / periods are tenant scoped (404 across books)', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const budA = (await a.client.post('/api/budgets', { name: 'A', period: 'monthly' })).body.id;
  const catB = (await b.client.post('/api/categories', { name: 'B', kind: 'expense' })).body.id;

  // B cannot read/write A's budget.
  assert.equal((await b.client.get(`/api/budgets/${budA}/lines`)).status, 404);
  assert.equal((await b.client.post(`/api/budgets/${budA}/lines`, { category_id: catB, amount: 10 })).status, 404);
  assert.equal((await b.client.get(`/api/budgets/${budA}/periods`)).status, 404);
  assert.equal((await b.client.put(`/api/budgets/${budA}/accounts`, { account_ids: [] })).status, 404);

  // A adding a line referencing B's category → 404 (cross-book category).
  assert.equal((await a.client.post(`/api/budgets/${budA}/lines`, { category_id: catB, amount: 10 })).status, 404);
});
