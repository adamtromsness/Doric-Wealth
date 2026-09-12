import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, type Client } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Deterministic-per-run calendar dates relative to today.
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const thisMonthDay = (day: number) => ymd(new Date(now.getFullYear(), now.getMonth(), day));
const lastMonthDay = (day: number) => ymd(new Date(now.getFullYear(), now.getMonth() - 1, day));
const firstOfLastMonth = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
const refToday = ymd(now);

const findLine = (progress: any, kind: string, categoryId: number) =>
  progress.sections.find((s: any) => s.kind === kind)?.groups.flatMap((g: any) => g.lines).find((l: any) => l.category_id === categoryId) ?? null;

async function newBudget(client: Client, body: any = { name: 'B', period: 'monthly' }) {
  return (await client.post('/api/budgets', body)).body.id as number;
}

test('progress attributes split transactions to each split category', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const catA = (await client.post('/api/categories', { name: 'CatA', kind: 'expense' })).body.id;
  const catB = (await client.post('/api/categories', { name: 'CatB', kind: 'expense' })).body.id;
  const bud = await newBudget(client);
  await client.post(`/api/budgets/${bud}/lines`, { category_id: catA, amount: 100 });
  await client.post(`/api/budgets/${bud}/lines`, { category_id: catB, amount: 100 });
  const r = await client.post('/api/transactions', { amount: 60, account_id: acct, direction: 'expense', txn_date: thisMonthDay(1), posted_date: thisMonthDay(1), splits: [{ amount: 30, category_id: catA }, { amount: 30, category_id: catB }] });
  assert.equal(r.status, 201);
  const prog = (await client.get(`/api/budgets/${bud}/progress?ref=${refToday}`)).body;
  assert.equal(findLine(prog, 'expense', catA).actual, 30);
  assert.equal(findLine(prog, 'expense', catB).actual, 30);
});

test('income budget lines track income actuals', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const salary = (await client.post('/api/categories', { name: 'Salary', kind: 'income' })).body.id;
  const bud = await newBudget(client);
  await client.post(`/api/budgets/${bud}/lines`, { category_id: salary, amount: 1000 });
  await client.post('/api/transactions', { amount: 1200, account_id: acct, category_id: salary, direction: 'income', txn_date: thisMonthDay(1), posted_date: thisMonthDay(1) });
  const line = findLine((await client.get(`/api/budgets/${bud}/progress?ref=${refToday}`)).body, 'income', salary);
  assert.equal(line.actual, 1200);
  assert.equal(line.base_amount, 1000);
});

test('carryover rollover folds prior under-spend into the current period', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Roll', kind: 'expense' })).body.id;
  const bud = await newBudget(client, { name: 'B', period: 'monthly', start_date: firstOfLastMonth });
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 100, rollover_mode: 'carryover' });
  await client.post('/api/transactions', { amount: 70, account_id: acct, category_id: cat, direction: 'expense', txn_date: lastMonthDay(10), posted_date: lastMonthDay(10) });
  const line = findLine((await client.get(`/api/budgets/${bud}/progress?ref=${refToday}`)).body, 'expense', cat);
  assert.equal(line.base_amount, 100);
  assert.equal(line.carry_in, 30);   // 100 planned last period − 70 spent
  assert.equal(line.allocated, 130); // this period's available = base + carry-in
});

test('custom-period budget uses its fixed window regardless of ref', async () => {
  const { client } = await registerUser(base);
  const bud = await newBudget(client, { name: 'C', period: 'custom', start_date: '2026-01-01', end_date: '2026-03-31' });
  const prog = (await client.get(`/api/budgets/${bud}/progress?ref=2026-08-15`)).body;
  assert.equal(prog.window.start, '2026-01-01');
  assert.equal(prog.window.end, '2026-03-31');
});

test('account scoping excludes transactions from unscoped accounts', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const b = (await client.post('/api/accounts', { name: 'B', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Scoped', kind: 'expense' })).body.id;
  const bud = await newBudget(client);
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 500 });
  await client.put(`/api/budgets/${bud}/accounts`, { account_ids: [a] }); // only account A counts
  await client.post('/api/transactions', { amount: 40, account_id: a, category_id: cat, direction: 'expense', txn_date: thisMonthDay(1), posted_date: thisMonthDay(1) });
  await client.post('/api/transactions', { amount: 25, account_id: b, category_id: cat, direction: 'expense', txn_date: thisMonthDay(1), posted_date: thisMonthDay(1) });
  const line = findLine((await client.get(`/api/budgets/${bud}/progress?ref=${refToday}`)).body, 'expense', cat);
  assert.equal(line.actual, 40); // only the account-A transaction is counted
});

test('snapshotted period keeps frozen category labels through a later rename', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Groceries', kind: 'expense' })).body.id;
  const bud = await newBudget(client);
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 100 });
  // Close/snapshot the June period (freezes name + kind + planned amount).
  assert.equal((await client.post(`/api/budgets/${bud}/periods`, { period_start: '2026-06-01', period_end: '2026-06-30' })).status, 201);

  const lineFor = async (ref: string) => findLine((await client.get(`/api/budgets/${bud}/progress?ref=${ref}`)).body, 'expense', cat);
  // Sanity: before the rename both windows show the original label.
  assert.equal((await lineFor('2026-06-15')).category_name, 'Groceries');

  // Rename the live category AFTER the period was snapshotted.
  assert.equal((await client.put(`/api/categories/${cat}`, { name: 'Food & Dining' })).status, 200);

  // Historical (snapshotted) period keeps the FROZEN label, not the new live name.
  const frozen = await lineFor('2026-06-15');
  assert.equal(frozen.category_name, 'Groceries', 'snapshotted label must not follow the rename');
  assert.equal(frozen.base_amount, 100);

  // A future, un-snapshotted period reflects the live (renamed) label.
  const live = await lineFor('2026-07-15');
  assert.equal(live.category_name, 'Food & Dining', 'un-snapshotted period uses the live label');
});

test('budget account scope validates every account id', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acct1 = (await a.client.post('/api/accounts', { name: 'A1', type: 'checking' })).body.id;
  const acct2 = (await a.client.post('/api/accounts', { name: 'A2', type: 'savings' })).body.id;
  const foreign = (await b.client.post('/api/accounts', { name: 'B1', type: 'checking' })).body.id;
  const bud = await newBudget(a.client);

  // Valid scope persists and is echoed back from the table.
  const ok = await a.client.put(`/api/budgets/${bud}/accounts`, { account_ids: [acct1, acct2] });
  assert.equal(ok.status, 200);
  assert.deepEqual([...ok.body.account_ids].sort((x: number, y: number) => x - y), [acct1, acct2].sort((x, y) => x - y));

  // Malformed account id → 400.
  const malformed = await a.client.put(`/api/budgets/${bud}/accounts`, { account_ids: [acct1, 'not-a-number'] });
  assert.equal(malformed.status, 400);

  // Cross-book account id → 404.
  const cross = await a.client.put(`/api/budgets/${bud}/accounts`, { account_ids: [acct1, foreign] });
  assert.equal(cross.status, 404);

  // Neither rejected request partially rewrote the scope — it stays [acct1, acct2].
  const after = (await a.client.get(`/api/budgets/${bud}/progress?ref=${refToday}`)).body;
  assert.deepEqual([...after.account_ids].sort((x: number, y: number) => x - y), [acct1, acct2].sort((x, y) => x - y));
});

test('snapshotted period keeps frozen GROUP (parent) headings through a parent rename', async () => {
  const { client } = await registerUser(base);
  const parent = (await client.post('/api/categories', { name: 'Housing', kind: 'expense' })).body.id;
  const child = (await client.post('/api/categories', { name: 'Rent', kind: 'expense', parent_id: parent })).body.id;
  const bud = await newBudget(client);
  await client.post(`/api/budgets/${bud}/lines`, { category_id: child, amount: 1000 });
  // Close/snapshot the June period (freezes item + group labels).
  assert.equal((await client.post(`/api/budgets/${bud}/periods`, { period_start: '2026-06-01', period_end: '2026-06-30' })).status, 201);

  const groupNameFor = async (ref: string) => {
    const prog = (await client.get(`/api/budgets/${bud}/progress?ref=${ref}`)).body;
    const section = prog.sections.find((s: any) => s.kind === 'expense');
    return section.groups.find((g: any) => g.lines.some((l: any) => l.category_id === child))?.group_name;
  };
  assert.equal(await groupNameFor('2026-06-15'), 'Housing');

  // Rename the PARENT group after the period was snapshotted.
  assert.equal((await client.put(`/api/categories/${parent}`, { name: 'Home Expenses' })).status, 200);

  // Snapshotted period keeps the frozen group heading; a future period uses the live one.
  assert.equal(await groupNameFor('2026-06-15'), 'Housing', 'snapshotted group heading must not follow the rename');
  assert.equal(await groupNameFor('2026-07-15'), 'Home Expenses', 'un-snapshotted period uses the live group name');
});

test('a snapshotted budget period is frozen against future line edits', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Frozen', kind: 'expense' })).body.id;
  const bud = await newBudget(client);
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 100 });
  assert.equal((await client.post(`/api/budgets/${bud}/periods`, { period_start: '2026-06-01', period_end: '2026-06-30' })).status, 201);
  const planned = async (ref: string) => findLine((await client.get(`/api/budgets/${bud}/progress?ref=${ref}`)).body, 'expense', cat)?.base_amount;
  assert.equal(await planned('2026-06-15'), 100); // reads the frozen snapshot
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 999 }); // a "future" edit
  assert.equal(await planned('2026-06-15'), 100); // historical period unchanged
  assert.equal(await planned('2026-07-15'), 999); // un-snapshotted period uses the live amount
});
