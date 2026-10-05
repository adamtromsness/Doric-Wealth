import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { stageSimplefinTxns } from '../src/routes/connections.js';
import { encryptSecret } from '../src/secrets.js';

// A canned SimpleFIN /accounts payload (no network) so the staging + dedup logic is
// tested deterministically. negative amount = money out; '0.00' must be skipped.
const PAYLOAD: any[] = [{
  org: { name: 'Test Bank' }, id: 'acct-1', name: 'Checking', currency: 'USD',
  balance: '100.00', 'balance-date': 1700000000,
  transactions: [
    { id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'COFFEE SHOP' },
    { id: 'tx-2', posted: 1700086400, amount: '2000.00', description: 'PAYROLL' },
    { id: 'tx-3', posted: 1700172800, amount: '0.00', description: 'ZERO' },
  ],
}];

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('simplefin staging: sign-maps direction and dedups by external id', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body;

  const db = testDbClient();
  await db.connect();
  try {
    // RLS context for direct writes.
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];
    await db.query(
      `INSERT INTO account_links (book_id, link_id, external_account_id, account_id) VALUES ($1,$2,'acct-1',$3)`,
      [bookId, link.id, acct.id]
    );
    const mapByExt = new Map<string, number>([['acct-1', acct.id]]);

    // First stage: tx-1 + tx-2 import, tx-3 (zero) skipped.
    const b1 = (await db.query(`INSERT INTO import_batches (book_id, source, total_rows) VALUES ($1,'simplefin',0) RETURNING id`, [bookId])).rows[0];
    const r1 = await stageSimplefinTxns(db as any, bookId, link.id, b1.id, PAYLOAD, mapByExt);
    assert.equal(r1.added, 2, 'first sync stages two transactions');
    assert.equal(r1.skipped, 1, 'zero-amount transaction is skipped');

    // Re-stage the identical payload: everything deduped, nothing added.
    const b2 = (await db.query(`INSERT INTO import_batches (book_id, source, total_rows) VALUES ($1,'simplefin',0) RETURNING id`, [bookId])).rows[0];
    const r2 = await stageSimplefinTxns(db as any, bookId, link.id, b2.id, PAYLOAD, mapByExt);
    assert.equal(r2.added, 0, 're-sync adds nothing (dedup by external id)');
    assert.equal(r2.skipped, 3, 're-sync skips all three');

    // Sign mapping is correct.
    const staged = (await db.query(
      `SELECT external_id, direction, amount::float8 AS amount FROM staged_transactions WHERE book_id = $1 ORDER BY external_id`,
      [bookId]
    )).rows;
    assert.equal(staged.length, 2);
    const byId: Record<string, any> = Object.fromEntries(staged.map((s: any) => [s.external_id, s]));
    assert.equal(byId['tx-1'].direction, 'expense');
    assert.equal(byId['tx-1'].amount, 12.5);
    assert.equal(byId['tx-2'].direction, 'income');
    assert.equal(byId['tx-2'].amount, 2000);

    // A balance snapshot was recorded for the (asset) account from the payload.
    const ev = (await db.query(
      `SELECT balance::float8 AS balance FROM account_balance_events
        WHERE book_id = $1 AND account_id = $2 AND source = 'simplefin' AND voided_at IS NULL`,
      [bookId, acct.id]
    )).rows;
    assert.equal(ev.length, 1, 'one synced balance event recorded');
    assert.equal(ev[0].balance, 100);
  } finally {
    await db.end();
  }
});

test('simplefin staging: a pending transaction (posted=0) is left for a later sync, once it posts', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body;
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];
    await db.query(`INSERT INTO account_links (book_id, link_id, external_account_id, account_id) VALUES ($1,$2,'a-1',$3)`, [bookId, link.id, acct.id]);
    // Pending transaction: posted=0, but transacted_at is set (2023-11-15).
    const payload: any[] = [{
      org: { name: 'Bank' }, id: 'a-1', name: 'Chk', currency: 'USD', balance: '10.00', 'balance-date': 1700000000,
      transactions: [{ id: 'pend-1', posted: 0, transacted_at: 1700000000, amount: '-9.99', description: 'PENDING SHOP', pending: true }],
    }];
    const b = (await db.query(`INSERT INTO import_batches (book_id, source, total_rows) VALUES ($1,'simplefin',0) RETURNING id`, [bookId])).rows[0];
    await stageSimplefinTxns(db as any, bookId, link.id, b.id, payload, new Map([['a-1', acct.id]]));
    const s = (await db.query(`SELECT 1 FROM staged_transactions WHERE book_id = $1 AND external_id = 'pend-1'`, [bookId])).rows;
    assert.equal(s.length, 0, 'pending imports are off: a pending charge is not staged (it would never get its posted amount and date)');
  } finally {
    await db.end();
  }
});

test('simplefin staging: a liability balance is stored as positive amount owed', async () => {
  const { client, bookId } = await registerUser(base);
  const card = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card', is_liability: true })).body;
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];
    await db.query(`INSERT INTO account_links (book_id, link_id, external_account_id, account_id) VALUES ($1,$2,'card-1',$3)`, [bookId, link.id, card.id]);
    // SimpleFIN reports a credit card balance as negative when money is owed.
    const payload: any[] = [{
      org: { name: 'Bank' }, id: 'card-1', name: 'Card', currency: 'USD',
      balance: '-500.00', 'balance-date': 1700000000,
      transactions: [{ id: 'c-1', posted: 1700000000, amount: '-40.00', description: 'STORE' }],
    }];
    const b = (await db.query(`INSERT INTO import_batches (book_id, source, total_rows) VALUES ($1,'simplefin',0) RETURNING id`, [bookId])).rows[0];
    await stageSimplefinTxns(db as any, bookId, link.id, b.id, payload, new Map([['card-1', card.id]]));
    const snap = (await db.query(`SELECT balance::float8 AS b FROM account_balances WHERE account_id = $1`, [card.id])).rows;
    assert.equal(snap.length, 1, 'a balance snapshot was recorded for the liability');
    assert.equal(snap[0].b, 500, 'negative SimpleFIN balance is stored as a positive amount owed');
  } finally {
    await db.end();
  }
});

test('confirming a staged simplefin row preserves source + external_id (dedup provenance)', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body;
  const db = testDbClient();
  await db.connect();
  let stagedId: number;
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];
    await db.query(`INSERT INTO account_links (book_id, link_id, external_account_id, account_id) VALUES ($1,$2,'a-1',$3)`, [bookId, link.id, acct.id]);
    const payload: any[] = [{
      org: { name: 'Bank' }, id: 'a-1', name: 'Chk', currency: 'USD', balance: '10.00', 'balance-date': 1700000000,
      transactions: [{ id: 'EXT-XYZ', posted: 1700000000, amount: '-5.00', description: 'SHOP' }],
    }];
    const b = (await db.query(`INSERT INTO import_batches (book_id, source, total_rows) VALUES ($1,'simplefin',0) RETURNING id`, [bookId])).rows[0];
    await stageSimplefinTxns(db as any, bookId, link.id, b.id, payload, new Map([['a-1', acct.id]]));
    stagedId = (await db.query(`SELECT id FROM staged_transactions WHERE book_id = $1 AND external_id = 'EXT-XYZ'`, [bookId])).rows[0].id;
  } finally {
    await db.end();
  }

  const r = await client.post(`/api/imports/staged/${stagedId}/confirm`);
  assert.ok(r.status >= 200 && r.status < 300, `confirm succeeded (got ${r.status})`);

  const db2 = testDbClient();
  await db2.connect();
  try {
    await db2.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const t = (await db2.query(`SELECT source, external_id FROM transactions WHERE book_id = $1 AND account_id = $2`, [bookId, acct.id])).rows;
    assert.equal(t.length, 1);
    assert.equal(t[0].source, 'simplefin', 'committed transaction keeps its source');
    assert.equal(t[0].external_id, 'EXT-XYZ', 'committed transaction keeps its external id (so re-syncs dedup)');
  } finally {
    await db2.end();
  }
});
