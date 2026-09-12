import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('empty book: zeroed net worth, empty series/accounts/recent/categorySpend', async () => {
  const { client } = await registerUser(base);
  const r = await client.get('/api/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.body.netWorth, 0);
  assert.equal(r.body.assets, 0);
  assert.equal(r.body.liabilities, 0);
  assert.deepEqual(r.body.series, []);
  assert.deepEqual(r.body.accounts, []);
  assert.deepEqual(r.body.recent, []);
  assert.deepEqual(r.body.categorySpend, []);
  assert.deepEqual(r.body.monthFlow, []);
});

test('net worth aggregates accounts, vehicles, assets, liabilities, and properties', async () => {
  const { client } = await registerUser(base);

  // Asset account (opening balance 1000) and a liability account (owed 500).
  await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 1000 });
  const card = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card', is_liability: true })).body.id;
  // Give the liability a posted balance of 500 via a snapshot.
  await client.post(`/api/accounts/${card}/balances`, { balance: 500, as_of: '2026-01-01' });

  // A vehicle (current_value 20000) and a generic asset (3000).
  await client.post('/api/vehicles', { name: 'Truck', current_value: 20000 });
  await client.post('/api/assets', { name: 'Art', asset_type: 'collectible', value: 3000 });

  // A standalone liability (2000 owed).
  await client.post('/api/liabilities', { name: 'Loan', liability_type: 'personal_loan', balance: 2000 });

  // A property worth 400000 with a 300000 mortgage (no mortgage_account_id → counts as a liability).
  await client.post('/api/properties', { name: 'House', current_value: 400000, mortgage_balance: 300000 });

  const r = (await client.get('/api/dashboard')).body;
  // assets = 1000 (checking) + 20000 (vehicle) + 3000 (asset) + 400000 (property)
  assert.equal(r.assets, 424000);
  // liabilities = 500 (card) + 2000 (loan) + 300000 (mortgage)
  assert.equal(r.liabilities, 302500);
  assert.equal(r.netWorth, 121500);

  // The accounts list carries computed balances and is ordered assets-then-liabilities.
  assert.equal(r.accounts.length, 2);
  assert.equal(r.accounts[0].is_liability, false); // asset account sorts first
  assert.equal(r.accounts[1].is_liability, true);
  const checking = r.accounts.find((a: any) => a.name === 'Checking');
  assert.equal(Number(checking.latest_balance), 1000);
});

test('net-worth series is derived from posted transaction flows and anchored to headline', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 0 })).body.id;

  // Two posted flows on distinct dates. Net worth today reflects both.
  await client.post('/api/transactions', { amount: 100, account_id: acct, direction: 'income', txn_date: '2026-03-01', posted_date: '2026-03-01' });
  await client.post('/api/transactions', { amount: 40, account_id: acct, direction: 'expense', txn_date: '2026-04-01', posted_date: '2026-04-01' });
  // A pending (posted_date null) flow must NOT appear in the series.
  await client.post('/api/transactions', { amount: 999, account_id: acct, direction: 'expense', txn_date: '2026-05-01', posted_date: null });

  const r = (await client.get('/api/dashboard')).body;
  assert.equal(r.series.length, 2, 'one point per posted flow date, pending excluded');
  // Series is anchored so the LAST point equals the headline net worth.
  const last = r.series[r.series.length - 1];
  assert.equal(last.net_worth, r.netWorth);
  // Dates are ascending.
  assert.ok(r.series[0].date <= r.series[1].date);
  // The first point = net worth minus the flow after it (i.e. minus the -40 expense).
  assert.equal(r.series[0].net_worth, r.netWorth - (-40));
});

test('monthFlow groups current-month income and expense; recent lists newest first', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;

  // Current-month flows (use today's month so date_trunc matches).
  const today = new Date().toISOString().slice(0, 10);
  await client.post('/api/transactions', { amount: 500, account_id: acct, direction: 'income', txn_date: today, posted_date: today, merchant: 'Payday' });
  await client.post('/api/transactions', { amount: 75, account_id: acct, direction: 'expense', txn_date: today, posted_date: today, merchant: 'Store' });

  const r = (await client.get('/api/dashboard')).body;
  const income = r.monthFlow.find((m: any) => m.direction === 'income');
  const expense = r.monthFlow.find((m: any) => m.direction === 'expense');
  assert.equal(Number(income.total), 500);
  assert.equal(Number(expense.total), 75);

  // Recent transactions include the joined account name and are capped at 10.
  assert.ok(r.recent.length >= 2);
  assert.equal(r.recent[0].account_name, 'Checking');
});

test('categorySpend rolls up this-month expenses by category (splits attributed to their part)', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const groceries = (await client.post('/api/categories', { name: 'Groceries', kind: 'expense' })).body.id;
  const gas = (await client.post('/api/categories', { name: 'Gas', kind: 'expense' })).body.id;
  const today = new Date().toISOString().slice(0, 10);

  // A straightforward categorized expense.
  await client.post('/api/transactions', { amount: 100, account_id: acct, direction: 'expense', txn_date: today, posted_date: today, category_id: groceries });
  // A split expense: each split attributed to its own category via effective lines.
  await client.post('/api/transactions', {
    amount: 60, account_id: acct, direction: 'expense', txn_date: today, posted_date: today,
    splits: [{ amount: 40, category_id: groceries }, { amount: 20, category_id: gas }],
  });
  // An uncategorized expense → falls under "Uncategorized".
  await client.post('/api/transactions', { amount: 15, account_id: acct, direction: 'expense', txn_date: today, posted_date: today });
  // Income must NOT appear in categorySpend.
  await client.post('/api/transactions', { amount: 1000, account_id: acct, direction: 'income', txn_date: today, posted_date: today, category_id: groceries });

  const r = (await client.get('/api/dashboard')).body;
  const byName = new Map(r.categorySpend.map((c: any) => [c.name, Number(c.total)]));
  assert.equal(byName.get('Groceries'), 140); // 100 + 40 split
  assert.equal(byName.get('Gas'), 20);
  assert.equal(byName.get('Uncategorized'), 15);
  // Ordered by total DESC → Groceries first.
  assert.equal(r.categorySpend[0].name, 'Groceries');
});

test('a disposed vehicle and archived property are excluded from net worth', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Old car', current_value: 8000 })).body.id;
  const prop = (await client.post('/api/properties', { name: 'Sold house', current_value: 100000, mortgage_balance: 0 })).body.id;

  let r = (await client.get('/api/dashboard')).body;
  assert.equal(r.assets, 108000);

  // Dispose both → they drop out of the totals (disposed_at IS NOT NULL is filtered).
  await client.post(`/api/vehicles/${veh}/dispose`, { disposed: true, disposal_type: 'sold', disposed_at: '2026-06-01' });
  await client.post(`/api/properties/${prop}/dispose`, { disposed: true, disposal_type: 'sold', disposed_at: '2026-06-01' });

  r = (await client.get('/api/dashboard')).body;
  assert.equal(r.assets, 0);
  assert.equal(r.netWorth, 0);
});

test('dashboard is book-scoped: another book never sees the first book\'s totals', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);

  await a.client.post('/api/accounts', { name: 'A checking', type: 'checking', opening_balance: 5000 });
  await a.client.post('/api/vehicles', { name: 'A car', current_value: 12000 });

  // B's dashboard is untouched by A's data.
  const rb = (await b.client.get('/api/dashboard')).body;
  assert.equal(rb.netWorth, 0);
  assert.equal(rb.assets, 0);
  assert.deepEqual(rb.accounts, []);

  // A sees its own totals.
  const ra = (await a.client.get('/api/dashboard')).body;
  assert.equal(ra.assets, 17000);
});
