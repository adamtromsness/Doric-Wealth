import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('tag report paginates the transaction list but aggregates the full set', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const tag = (await client.post('/api/tags', { name: 'Trip' })).body.id;
  // Three tagged expenses on distinct dates (10 + 20 + 30 = 60).
  for (const [amt, d] of [[10, '2026-01-01'], [20, '2026-02-01'], [30, '2026-03-01']] as const) {
    const r = await client.post('/api/transactions', { amount: amt, account_id: acct, direction: 'expense', txn_date: d, tags: [{ kind: 'tag', ref_id: tag }] });
    assert.equal(r.status, 201);
  }

  // Page 1: 2 of 3 rows, but the total + aggregates cover all three.
  const p1 = (await client.get(`/api/tags/${tag}/report?limit=2&offset=0`)).body;
  assert.equal(p1.transactions.length, 2, 'first page holds the page size');
  assert.equal(p1.transactions_total, 3, 'total counts every tagged transaction');
  assert.equal(Number(p1.totals.expense), 60, 'aggregates are over the full set, not the page');

  // Page 2: the remaining row.
  const p2 = (await client.get(`/api/tags/${tag}/report?limit=2&offset=2`)).body;
  assert.equal(p2.transactions.length, 1, 'second page holds the remainder');
  assert.equal(p2.transactions_total, 3);

  // No page overlap (newest-first ordering).
  const ids1 = new Set(p1.transactions.map((x: any) => x.txn_id));
  assert.ok(!p2.transactions.some((x: any) => ids1.has(x.txn_id)), 'pages do not overlap');
});
