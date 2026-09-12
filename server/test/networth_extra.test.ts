import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('GET /networth aggregates every asset & liability source into grouped totals', async () => {
  const { client } = await registerUser(base);

  // Asset account + liability account.
  const checking = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 1000 })).body.id;
  await client.post('/api/accounts', { name: 'Card', type: 'credit_card', is_liability: true, opening_balance: 300 });

  // Property with an UNLINKED mortgage (counts as an asset via current_value AND
  // as a "Property mortgages" liability group).
  await client.post('/api/properties', { name: 'Home', current_value: 5000, mortgage_balance: 2000 });

  // Vehicle asset.
  await client.post('/api/vehicles', { name: 'Truck', current_value: 800 });

  // Generic asset + generic liability (drive the groupBy branches).
  await client.post('/api/assets', { name: 'Rolex', asset_type: 'collectible', value: 400 });
  await client.post('/api/liabilities', { name: 'Student Loan', liability_type: 'student_loan', balance: 1500 });

  void checking;
  const nw = (await client.get('/api/networth')).body;

  // Asset groups: only non-empty ones are returned.
  const aGroup = (t: string) => nw.assetGroups.find((g: any) => g.type === t);
  assert.equal(aGroup('account').total, 1000);
  assert.equal(aGroup('property').total, 5000);
  assert.equal(aGroup('vehicle').total, 800);
  assert.equal(aGroup('collectible').total, 400);

  // Liability groups: account-based, property mortgage, and generic.
  const lGroup = (t: string) => nw.liabilityGroups.find((g: any) => g.type === t);
  assert.equal(lGroup('account:credit_card').total, 300);
  assert.equal(lGroup('property_mortgage').total, 2000);
  assert.equal(lGroup('student_loan').total, 1500);

  // Headline totals reconcile.
  assert.equal(nw.totals.assets, 1000 + 5000 + 800 + 400);
  assert.equal(nw.totals.liabilities, 300 + 2000 + 1500);
  assert.equal(nw.totals.netWorth, nw.totals.assets - nw.totals.liabilities);

  // Raw asset/liability rows are echoed too.
  assert.ok(nw.assets.some((a: any) => a.name === 'Rolex'));
  assert.ok(nw.liabilities.some((l: any) => l.name === 'Student Loan'));
});

test('GET /networth for an empty book yields zero totals and no groups', async () => {
  const { client } = await registerUser(base);
  const nw = (await client.get('/api/networth')).body;
  assert.equal(nw.totals.assets, 0);
  assert.equal(nw.totals.liabilities, 0);
  assert.equal(nw.totals.netWorth, 0);
  assert.deepEqual(nw.assetGroups, [], 'no non-empty asset groups');
  assert.deepEqual(nw.liabilityGroups, [], 'no liability groups');
});

test('GET /networth/cash-flow returns monthly income/expense/net and honours months=', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const thisMonth = new Date().toISOString().slice(0, 8) + '05'; // YYYY-MM-05, within the window
  await client.post('/api/transactions', { amount: 500, account_id: acct, direction: 'income', txn_date: thisMonth });
  await client.post('/api/transactions', { amount: 200, account_id: acct, direction: 'expense', txn_date: thisMonth });
  // Transfers are excluded from cash-flow.
  const other = (await client.post('/api/accounts', { name: 'Savings', type: 'savings' })).body.id;
  await client.post('/api/transactions', { amount: 100, account_id: acct, transfer_account_id: other, direction: 'transfer', txn_date: thisMonth });

  const cf = (await client.get('/api/networth/cash-flow')).body.series;
  const month = thisMonth.slice(0, 7);
  const row = cf.find((r: any) => r.month === month);
  assert.ok(row, 'the current month appears in the series');
  assert.equal(row.income, 500);
  assert.equal(row.expense, 200);
  assert.equal(row.net, 300, 'net = income - expense; transfers excluded');

  // months= is clamped to [1, 60]; an out-of-range value still returns a series.
  assert.ok(Array.isArray((await client.get('/api/networth/cash-flow?months=999')).body.series));
  assert.ok(Array.isArray((await client.get('/api/networth/cash-flow?months=0')).body.series));
});

test('networth time-series endpoints are empty for a book with no dated facts', async () => {
  const { client } = await registerUser(base);
  assert.deepEqual((await client.get('/api/networth/history')).body.series, []);
  assert.deepEqual((await client.get('/api/networth/asset-history')).body.series, []);
  assert.deepEqual((await client.get('/api/networth/liability-history')).body.series, []);
  assert.deepEqual((await client.get('/api/networth/over-time')).body.series, []);
});
