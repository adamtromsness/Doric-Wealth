import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// ── Savings goals ───────────────────────────────────────────────────────────
test('savings goal: manual amount, account-linked, and asset-linked progress', async () => {
  const { client } = await registerUser(base);

  // Manual current_amount, no linked source. 50 / 200 = 25%, on_track.
  const manual = await client.post('/api/goals', {
    name: 'Emergency fund', goal_type: 'savings', target_amount: 200, current_amount: 50,
  });
  assert.equal(manual.status, 201);
  assert.equal(manual.body.progress.current, 50);
  assert.equal(manual.body.progress.target, 200);
  assert.equal(manual.body.progress.pct, 25);
  assert.equal(manual.body.progress.remaining, 150);
  assert.equal(manual.body.progress.state, 'on_track');

  // Account-linked: current comes from the account's posted balance, not current_amount.
  const acct = (await client.post('/api/accounts', { name: 'Savings', type: 'savings', opening_balance: 300 })).body.id;
  const linked = await client.post('/api/goals', {
    name: 'Down payment', goal_type: 'savings', target_amount: 300, account_id: acct, current_amount: 0,
  });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.progress.current, 300);
  assert.equal(linked.body.progress.pct, 100);
  assert.equal(linked.body.progress.remaining, 0);
  assert.equal(linked.body.progress.state, 'achieved'); // current >= target

  // Asset-linked: current comes from the asset's value.
  const asset = (await client.post('/api/assets', { name: 'Gold', asset_type: 'collectible', value: 1000 })).body.id;
  const assetGoal = await client.post('/api/goals', {
    name: 'Collectibles', goal_type: 'savings', target_amount: 4000, asset_id: asset,
  });
  assert.equal(assetGoal.body.progress.current, 1000);
  assert.equal(assetGoal.body.progress.pct, 25);
  assert.equal(assetGoal.body.progress.state, 'on_track');

  // Zero target → pct 0, no divide-by-zero.
  const zero = await client.post('/api/goals', { name: 'Untargeted', goal_type: 'savings', target_amount: 0 });
  assert.equal(zero.body.progress.pct, 0);
});

// ── Debt payoff goals ───────────────────────────────────────────────────────
test('debt_payoff goal: liability-linked, account-linked, and manual with baseline', async () => {
  const { client } = await registerUser(base);

  // Liability-linked. baseline 10000 → target 0; current 6000 → paid 4000, 40%.
  const liab = (await client.post('/api/liabilities', { name: 'Student loan', liability_type: 'student_loan', balance: 6000 })).body.id;
  const g = await client.post('/api/goals', {
    name: 'Pay off loan', goal_type: 'debt_payoff', target_amount: 0, baseline_amount: 10000, liability_id: liab,
  });
  assert.equal(g.status, 201);
  assert.equal(g.body.progress.current, 6000);
  assert.equal(g.body.progress.baseline, 10000);
  assert.equal(g.body.progress.paid, 4000);
  assert.equal(g.body.progress.pct, 40);
  assert.equal(g.body.progress.remaining, 6000); // current - target
  assert.equal(g.body.progress.state, 'on_track');

  // Account-linked debt: a liability account with a negative posted balance.
  const acct = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card', is_liability: true, opening_balance: -500 })).body.id;
  const acctGoal = await client.post('/api/goals', {
    name: 'Pay card', goal_type: 'debt_payoff', target_amount: 0, baseline_amount: -500, account_id: acct,
  });
  assert.equal(acctGoal.body.progress.current, -500);
  // current (-500) <= target (0) → achieved.
  assert.equal(acctGoal.body.progress.state, 'achieved');
  assert.equal(acctGoal.body.progress.pct, 100);

  // Manual with no baseline → baseline defaults to current; span 0 and current<=target → 100%.
  const manual = await client.post('/api/goals', {
    name: 'Manual debt', goal_type: 'debt_payoff', target_amount: 1000, current_amount: 1000,
  });
  assert.equal(manual.body.progress.current, 1000);
  assert.equal(manual.body.progress.baseline, 1000);
  assert.equal(manual.body.progress.pct, 100);
  assert.equal(manual.body.progress.state, 'achieved');
  assert.equal(manual.body.progress.remaining, 0);

  // Manual still owing: baseline 2000, current 1500, target 500 → paid 500 / span 1500.
  const owing = await client.post('/api/goals', {
    name: 'Still owing', goal_type: 'debt_payoff', target_amount: 500, baseline_amount: 2000, current_amount: 1500,
  });
  assert.equal(owing.body.progress.paid, 500);
  assert.equal(Math.round(owing.body.progress.pct), 33);
  assert.equal(owing.body.progress.remaining, 1000);
  assert.equal(owing.body.progress.state, 'on_track');
});

// ── Reduce-spending goals ───────────────────────────────────────────────────
test('reduce_spending goal: spend in the current period vs the cap', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Dining', kind: 'expense' })).body.id;

  // Two expenses this month in the category (use a fixed ref so we pin the window).
  const ref = '2026-06-15';
  await client.post('/api/transactions', { amount: 30, account_id: acct, direction: 'expense', txn_date: '2026-06-05', category_id: cat });
  await client.post('/api/transactions', { amount: 45, account_id: acct, direction: 'expense', txn_date: '2026-06-10', category_id: cat });
  // An out-of-window expense that must NOT count.
  await client.post('/api/transactions', { amount: 100, account_id: acct, direction: 'expense', txn_date: '2026-05-01', category_id: cat });

  const g = (await client.post('/api/goals', {
    name: 'Eat out less', goal_type: 'reduce_spending', target_amount: 100, period: 'monthly', category_id: cat,
  })).body;

  // Re-read via the list with the ref query so the window resolves to June 2026.
  const list = (await client.get(`/api/goals?ref=${ref}`)).body;
  const row = list.find((x: any) => x.id === g.id);
  assert.equal(row.progress.current, 75); // 30 + 45, the May expense excluded
  assert.equal(row.progress.target, 100);
  assert.equal(row.progress.pct, 75);
  assert.equal(row.progress.remaining, 25);
  assert.equal(row.progress.period, 'monthly');
  assert.equal(row.progress.state, 'on_track');
  assert.ok(row.progress.windowLabel);

  // Over the cap → state 'over', negative remaining.
  const overCat = (await client.post('/api/categories', { name: 'Shopping', kind: 'expense' })).body.id;
  await client.post('/api/transactions', { amount: 250, account_id: acct, direction: 'expense', txn_date: '2026-06-08', category_id: overCat });
  const over = (await client.post('/api/goals', {
    name: 'Shop less', goal_type: 'reduce_spending', target_amount: 100, period: 'monthly', category_id: overCat,
  })).body;
  const overRow = (await client.get(`/api/goals?ref=${ref}`)).body.find((x: any) => x.id === over.id);
  assert.equal(overRow.progress.current, 250);
  assert.equal(overRow.progress.state, 'over');
  assert.equal(overRow.progress.remaining, -150);

  // A reduce_spending goal defaults to a 'monthly' period when none is given.
  const noPeriod = (await client.post('/api/goals', {
    name: 'No period', goal_type: 'reduce_spending', target_amount: 50, category_id: cat,
  })).body;
  assert.equal(noPeriod.progress.period, 'monthly');
});

// ── List ordering + empty state ─────────────────────────────────────────────
test('GET /goals returns joined names and an empty array for a fresh book', async () => {
  const { client } = await registerUser(base);
  assert.deepEqual((await client.get('/api/goals')).body, []);

  const acct = (await client.post('/api/accounts', { name: 'Vault', type: 'savings', opening_balance: 10 })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Fun', kind: 'expense' })).body.id;
  await client.post('/api/goals', { name: 'A goal', goal_type: 'savings', target_amount: 100, account_id: acct });
  await client.post('/api/goals', { name: 'B goal', goal_type: 'reduce_spending', target_amount: 100, period: 'monthly', category_id: cat });

  const list = (await client.get('/api/goals')).body;
  assert.equal(list.length, 2);
  const savings = list.find((g: any) => g.name === 'A goal');
  assert.equal(savings.account_name, 'Vault');
  const reduce = list.find((g: any) => g.name === 'B goal');
  assert.equal(reduce.category_name, 'Fun');
});

// ── Update + delete ─────────────────────────────────────────────────────────
test('PUT /goals/:id updates fields and recomputes progress; 404 for a missing id', async () => {
  const { client } = await registerUser(base);
  const g = (await client.post('/api/goals', { name: 'Original', goal_type: 'savings', target_amount: 100, current_amount: 25 })).body;

  const upd = await client.put(`/api/goals/${g.id}`, {
    name: 'Renamed', goal_type: 'savings', target_amount: 100, current_amount: 100, status: 'archived',
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Renamed');
  assert.equal(upd.body.status, 'archived');
  assert.equal(upd.body.progress.current, 100);
  assert.equal(upd.body.progress.state, 'achieved');

  // Partial update: name omitted → COALESCE keeps it.
  const partial = await client.put(`/api/goals/${g.id}`, { goal_type: 'savings', target_amount: 200, current_amount: 100 });
  assert.equal(partial.body.name, 'Renamed');
  assert.equal(partial.body.progress.target, 200);

  assert.equal((await client.put('/api/goals/99999', { goal_type: 'savings', target_amount: 5 })).status, 404);
});

test('DELETE /goals/:id removes the goal (idempotent 204)', async () => {
  const { client } = await registerUser(base);
  const g = (await client.post('/api/goals', { name: 'Doomed', goal_type: 'savings', target_amount: 10 })).body;

  assert.equal((await client.del(`/api/goals/${g.id}`)).status, 204);
  assert.equal((await client.get('/api/goals')).body.find((x: any) => x.id === g.id), undefined);
  // Deleting again (or a never-existing id) is a no-op 204.
  assert.equal((await client.del(`/api/goals/${g.id}`)).status, 204);
  assert.equal((await client.del('/api/goals/99999')).status, 204);
});

// ── Validation ──────────────────────────────────────────────────────────────
test('POST /goals validation: required fields, enums, money, and dates', async () => {
  const { client } = await registerUser(base);

  // Missing name / goal_type → 400.
  assert.equal((await client.post('/api/goals', { goal_type: 'savings' })).status, 400);
  assert.equal((await client.post('/api/goals', { name: 'X' })).status, 400);

  // Bad goal_type enum → 400.
  assert.equal((await client.post('/api/goals', { name: 'X', goal_type: 'nonsense' })).status, 400);
  // Bad status / period enums → 400.
  assert.equal((await client.post('/api/goals', { name: 'X', goal_type: 'savings', status: 'bogus' })).status, 400);
  assert.equal((await client.post('/api/goals', { name: 'X', goal_type: 'reduce_spending', period: 'daily' })).status, 400);
  // Sub-cent money → 400 (money() rejects it).
  assert.equal((await client.post('/api/goals', { name: 'X', goal_type: 'savings', target_amount: 1.005 })).status, 400);
  // Bad target_date → 400.
  assert.equal((await client.post('/api/goals', { name: 'X', goal_type: 'savings', target_date: 'not-a-date' })).status, 400);
});

// ── Cross-book isolation ────────────────────────────────────────────────────
test('goals are book-scoped: cross-book refs 404, and a foreign goal is unreachable', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);

  const acctB = (await b.client.post('/api/accounts', { name: 'B acct', type: 'savings', opening_balance: 100 })).body.id;

  // A cannot link B's account → 404.
  assert.equal((await a.client.post('/api/goals', { name: 'Cross', goal_type: 'savings', target_amount: 100, account_id: acctB })).status, 404);

  const goalA = (await a.client.post('/api/goals', { name: 'A goal', goal_type: 'savings', target_amount: 100 })).body;
  // B's list doesn't include A's goal.
  assert.equal((await b.client.get('/api/goals')).body.find((g: any) => g.id === goalA.id), undefined);
  // B cannot update A's goal → 404.
  assert.equal((await b.client.put(`/api/goals/${goalA.id}`, { goal_type: 'savings', target_amount: 5 })).status, 404);
  // B "deleting" A's goal is a no-op (book-scoped WHERE) but returns 204; A's goal survives.
  assert.equal((await b.client.del(`/api/goals/${goalA.id}`)).status, 204);
  assert.ok((await a.client.get('/api/goals')).body.find((g: any) => g.id === goalA.id));
});
