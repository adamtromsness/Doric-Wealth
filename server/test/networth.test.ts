import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Helper: net worth as of a given date from /api/networth/history (null if no point).
function pointFor(series: any[], date: string): number | null {
  const p = series.find((s) => s.date === date);
  return p ? Number(p.net_worth) : null;
}

test('deleting a balance snapshot removes it from net-worth history', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Brokerage', type: 'brokerage', opening_balance: 0 })).body.id;

  // Create a dated snapshot worth 1000.
  const snap = await client.post(`/api/accounts/${acct}/balances`, { balance: 1000, as_of: '2026-03-15' });
  assert.equal(snap.status, 201);
  const balanceId = snap.body.id;

  // Net-worth history reflects the snapshot.
  let hist = (await client.get('/api/networth/history')).body.series;
  assert.equal(pointFor(hist, '2026-03-15'), 1000, 'history should reflect the new snapshot');

  // The ledger and the snapshot list both show the fact.
  assert.equal((await client.get(`/api/accounts/${acct}/balance-events`)).body.length, 1);
  assert.equal((await client.get(`/api/accounts/${acct}/balances`)).body.length, 1);

  // Delete the snapshot.
  const del = await client.del(`/api/accounts/${acct}/balances/${balanceId}`);
  assert.equal(del.status, 204);

  // Net-worth history no longer reflects the deleted snapshot. With no remaining
  // balance facts the series is empty (graceful fallback for no events).
  hist = (await client.get('/api/networth/history')).body.series;
  assert.equal(pointFor(hist, '2026-03-15'), null, 'deleted snapshot must not appear in history');
  assert.equal(hist.length, 0, 'no balance facts remain, so history is empty');

  // The ledger event is voided (hidden from the per-account ledger view).
  assert.equal((await client.get(`/api/accounts/${acct}/balance-events`)).body.length, 0);
  // The snapshot itself is gone from the balances list.
  assert.equal((await client.get(`/api/accounts/${acct}/balances`)).body.length, 0);
});

test('deleting one snapshot leaves other dated snapshots intact in history', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Savings', type: 'savings', opening_balance: 0 })).body.id;

  const s1 = (await client.post(`/api/accounts/${acct}/balances`, { balance: 500, as_of: '2026-01-01' })).body;
  const s2 = (await client.post(`/api/accounts/${acct}/balances`, { balance: 800, as_of: '2026-02-01' })).body;

  let hist = (await client.get('/api/networth/history')).body.series;
  assert.equal(pointFor(hist, '2026-01-01'), 500);
  assert.equal(pointFor(hist, '2026-02-01'), 800);

  // Delete only the later snapshot.
  assert.equal((await client.del(`/api/accounts/${acct}/balances/${s2.id}`)).status, 204);

  hist = (await client.get('/api/networth/history')).body.series;
  assert.equal(pointFor(hist, '2026-01-01'), 500, 'untouched snapshot still counts');
  assert.equal(pointFor(hist, '2026-02-01'), null, 'deleted snapshot date drops out');
  assert.equal(hist.length, 1, 'only the remaining snapshot date is present');

  void s1;
});

// Characterization of the snapshot-based over-time series (the correlated-subquery
// forward-fill: each entity contributes its most-recent value as of each date, falling
// back to its current/opening value before its first fact). Locks the exact numbers so
// any rewrite of those queries must reproduce them.
test('over-time series forward-fills each entity and falls back before its first fact', async () => {
  const { client } = await registerUser(base);
  // Asset account: events 300@2026-01-01, 500@2026-03-01 (opening 100, never reached).
  const cash = (await client.post('/api/accounts', { name: 'Cash', type: 'checking', opening_balance: 100 })).body.id;
  await client.post(`/api/accounts/${cash}/balances`, { balance: 300, as_of: '2026-01-01' });
  await client.post(`/api/accounts/${cash}/balances`, { balance: 500, as_of: '2026-03-01' });
  // Liability account: one event 150@2026-03-01 (opening 0 before that).
  const card = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card', is_liability: true, opening_balance: 0 })).body.id;
  await client.post(`/api/accounts/${card}/balances`, { balance: 150, as_of: '2026-03-01' });
  // Property: value snapshots 1200@2026-02-01, 1400@2026-03-01 → current_value syncs to 1400.
  const home = (await client.post('/api/properties', { name: 'Home' })).body.id;
  await client.post(`/api/properties/${home}/values`, { value: 1200, as_of: '2026-02-01' });
  await client.post(`/api/properties/${home}/values`, { value: 1400, as_of: '2026-03-01' });

  // /over-time: axis = union of every fact date; assets = accounts + property (fwd-filled,
  // current_value=1400 fallback before the property's first snapshot).
  const over = (await client.get('/api/networth/over-time')).body.series as any[];
  assert.deepEqual(over, [
    { date: '2026-01-01', assets: 1700, liabilities: 0, net_worth: 1700 },   // cash 300 + property fallback 1400
    { date: '2026-02-01', assets: 1500, liabilities: 0, net_worth: 1500 },   // cash 300 (carried) + property 1200
    { date: '2026-03-01', assets: 1900, liabilities: 150, net_worth: 1750 }, // cash 500 + property 1400 − card 150
  ]);

  // /asset-history: assets only, axis = account-event ∪ property-value dates.
  const assetH = (await client.get('/api/networth/asset-history')).body.series as any[];
  assert.deepEqual(assetH.map((r) => ({ date: r.date, value: Number(r.value) })), [
    { date: '2026-01-01', value: 1700 },
    { date: '2026-02-01', value: 1500 },
    { date: '2026-03-01', value: 1900 },
  ]);

  // /liability-history: liabilities only, axis = account-event ∪ liability_balances
  // dates (NOT property-value dates, so no 2026-02-01 point).
  const liabH = (await client.get('/api/networth/liability-history')).body.series as any[];
  assert.deepEqual(liabH.map((r) => ({ date: r.date, value: Number(r.value) })), [
    { date: '2026-01-01', value: 0 },
    { date: '2026-03-01', value: 150 },
  ]);
});

// The date axis is bucketed to one point per month (the latest fact date that month),
// so a month with many facts (e.g. daily bank-synced balances) collapses to a single
// point instead of one per day. A month with a single fact is unchanged (above).
test('over-time buckets multiple facts in a month to one point at the latest date', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Brokerage', type: 'brokerage', opening_balance: 0 })).body.id;
  await client.post(`/api/accounts/${acct}/balances`, { balance: 100, as_of: '2026-05-10' });
  await client.post(`/api/accounts/${acct}/balances`, { balance: 200, as_of: '2026-05-20' });
  await client.post(`/api/accounts/${acct}/balances`, { balance: 250, as_of: '2026-06-05' });

  const hist = (await client.get('/api/networth/history')).body.series as any[];
  assert.deepEqual(hist.map((r) => ({ date: r.date, net_worth: Number(r.net_worth) })), [
    { date: '2026-05-20', net_worth: 200 }, // May's two facts → one point at the later date (200), not two
    { date: '2026-06-05', net_worth: 250 },
  ]);
});

test('balance_adjustments audit stays append-only across a snapshot delete', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 0 })).body.id;

  const snap = (await client.post(`/api/accounts/${acct}/balances`, { balance: 250, as_of: '2026-04-10' })).body;
  const before = (await client.get(`/api/accounts/${acct}/adjustments`)).body;
  assert.equal(before.length, 1, 'snapshot creates one audit row');

  // Deleting the snapshot must NOT remove or mutate the audit history.
  assert.equal((await client.del(`/api/accounts/${acct}/balances/${snap.id}`)).status, 204);
  const after = (await client.get(`/api/accounts/${acct}/adjustments`)).body;
  assert.equal(after.length, 1, 'audit row survives the snapshot deletion');
  assert.equal(Number(after[0].new_balance), 250);
  assert.equal(after[0].id, before[0].id, 'same audit row, untouched');
});
