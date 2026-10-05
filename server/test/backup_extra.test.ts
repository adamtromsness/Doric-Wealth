import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { runDueBackupsSafe, restoreTestHooks } from '../src/routes/backup.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const listSnaps = async (client: any) => (await client.get('/api/backup/snapshots')).body.snapshots;

test('groups endpoint reports row counts and byte sizes per data set', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'Checking', type: 'checking' });
  await client.post('/api/categories', { name: 'Food', kind: 'expense' });

  const groups = (await client.get('/api/backup/groups')).body as any[];
  assert.ok(Array.isArray(groups));
  const accts = groups.find((g) => g.key === 'accounts');
  assert.ok(accts, 'accounts group present');
  assert.ok(accts.rows >= 1, 'counts the account row');
  assert.ok(accts.bytes >= 0);
  const cats = groups.find((g) => g.key === 'categories');
  assert.ok(cats.rows >= 1);
});

test('preview validates and summarizes an uploaded envelope', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'A', type: 'checking' });
  const env = (await client.get('/api/backup/export')).body;

  const pv = await client.post('/api/backup/preview', env);
  assert.equal(pv.status, 200);
  assert.ok(pv.body.total_rows >= 1);
  assert.equal(pv.body.schema_mismatch, false, 'a fresh export matches the current schema');
  assert.ok(pv.body.counts.accounts >= 1);

  // A non-backup body → 400.
  assert.equal((await client.post('/api/backup/preview', { nope: true })).status, 400);
});

test('import validates confirm token and envelope shape', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'A', type: 'checking' });
  const env = (await client.get('/api/backup/export')).body;

  // Missing confirm → 400.
  assert.equal((await client.post('/api/backup/import', { ...env })).status, 400);
  // Not a valid backup → 400.
  assert.equal((await client.post('/api/backup/import', { confirm: 'REPLACE', app: 'other' })).status, 400);
  // Valid round-trip.
  assert.equal((await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
});

test('selective restore is rejected when it depends on data sets not in the backup', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  const bud = (await client.post('/api/budgets', { name: 'B', period: 'monthly' })).body.id;
  await client.post(`/api/budgets/${bud}/lines`, { category_id: cat, amount: 100 });

  // Export ONLY the budgets group, and restore it into another book. budget_lines
  // .category_id is a required link to categories, which aren't in the backup and
  // don't exist in that book, so the pre-flight must refuse before anything is wiped.
  const env = (await client.get('/api/backup/export?groups=budgets')).body;
  const other = await registerUser(base);
  const pv = (await other.client.post('/api/backup/preview', env)).body;
  assert.match(pv.problems.join(' '), /depends on data sets/);
  const imp = await other.client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
  assert.equal(imp.status, 400);
  assert.match(imp.body.error, /depends on data sets/);
  assert.match(imp.body.error, /Categories/i);

  // In its own book the category still exists, so the same restore is fine.
  assert.equal((await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
  assert.equal((await client.get(`/api/budgets/${bud}`)).status, 404, 'the budget was replaced (new id)');
});

test('selective restore keeps links to rows this book still has, and drops links it can\'t resolve', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-01' });

  // Restoring transactions alone into the same book: the account is still there.
  const env = (await client.get('/api/backup/export?groups=transactions')).body;
  assert.equal((await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
  const txns = (await client.get('/api/transactions')).body.posted;
  assert.equal(txns.length, 1);
  assert.equal(txns[0].account_id, acct, 'the account link survives a same-book restore');

  // Into another book, that account doesn't exist: the nullable link is dropped.
  const other = await registerUser(base);
  assert.equal((await other.client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
  const theirs = (await other.client.get('/api/transactions')).body.posted;
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].account_id, null, 'an unresolvable link is dropped, never pointed at another book');
  // The preview said so beforehand.
  const pv = (await other.client.post('/api/backup/preview', env)).body;
  assert.deepEqual(pv.problems, []);
  assert.match(pv.warnings.join(' '), /will be removed: Accounts & balances \(1\)/);
});

test('a selective restore that would unlink or delete data outside it is refused, with an accurate preview', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-01', merchant: 'Shop' });
  const env = (await client.get('/api/backup/export?groups=accounts')).body;

  const pv = (await client.post('/api/backup/preview', env)).body;
  assert.deepEqual(pv.replaces, ['Accounts & balances']);
  assert.ok(pv.current_rows >= 1);
  assert.equal(pv.problems.length, 1);
  assert.match(pv.problems[0], /would unlink or delete records that point at it \(1 in Transactions\)/);

  const imp = await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
  assert.equal(imp.status, 400);
  assert.match(imp.body.error, /Restore a full backup instead/);
  const txns = (await client.get('/api/transactions')).body.posted;
  assert.equal(txns[0].account_id, acct, 'nothing changed');

  // A tag on a transaction pointing at a vehicle blocks a vehicles-only restore too
  // (a reference that isn't a declared foreign key).
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body.id;
  await client.post('/api/transactions', { amount: 5, account_id: acct, direction: 'expense', txn_date: '2026-06-02', tags: [{ kind: 'vehicle', ref_id: veh }] });
  const vEnv = (await client.get('/api/backup/export?groups=vehicles')).body;
  const vImp = await client.post('/api/backup/import', { ...vEnv, confirm: 'REPLACE' });
  assert.equal(vImp.status, 400);
  assert.match(vImp.body.error, /1 in Transactions/);
  void bookId;
});

test('a full restore remaps references that aren\'t foreign keys (tags, managed categories, insurance, maintenance links)', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Blue Car' })).body.id;
  const tagged = (await client.post('/api/transactions', {
    amount: 40, account_id: acct, direction: 'expense', txn_date: '2026-06-01', merchant: 'Oil Change', tags: [{ kind: 'vehicle', ref_id: veh }],
  })).body.id;
  assert.equal((await client.post(`/api/vehicles/${veh}/insurance`, { policy_type: 'Auto', carrier: 'Acme' })).status, 201);
  const util = (await client.post('/api/utilities/accounts', { name: 'City Power', utility_type: 'electricity' })).body.id;
  const asset = (await client.post('/api/assets', { name: 'Boat', kind: 'other' })).body.id;
  const maint = (await client.post(`/api/assets/${asset}/maintenance`, { item: 'Winterize' })).body.id;
  const db = testDbClient();
  await db.connect();
  const read = async () => {
    const one = async (sql: string) => (await db.query(sql, [bookId])).rows;
    return {
      tag: await one(`SELECT v.name FROM line_tags lt JOIN vehicles v ON v.id = lt.ref_id AND v.book_id = lt.book_id JOIN transactions t ON t.id = lt.transaction_id WHERE lt.book_id = $1 AND lt.kind = 'vehicle' AND t.merchant = 'Oil Change'`),
      ins: await one(`SELECT v.name FROM insurance_policies ip JOIN vehicles v ON v.id = ip.entity_id AND v.book_id = ip.book_id WHERE ip.book_id = $1 AND ip.entity_kind = 'vehicle'`),
      cat: await one(`SELECT u.name FROM categories c JOIN utility_accounts u ON u.id = c.source_id AND u.book_id = c.book_id WHERE c.book_id = $1 AND c.managed AND c.source_kind = 'utility'`),
      maint: await one(`SELECT t.merchant FROM asset_maintenance m JOIN transactions t ON t.id = m.transaction_id AND t.book_id = m.book_id WHERE m.book_id = $1`),
    };
  };
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await db.query(`UPDATE asset_maintenance SET transaction_id = $1 WHERE id = $2`, [tagged, maint]);
    const before = await read();
    assert.deepEqual(before, { tag: [{ name: 'Blue Car' }], ins: [{ name: 'Blue Car' }], cat: [{ name: 'City Power' }], maint: [{ merchant: 'Oil Change' }] });

    const env = (await client.get('/api/backup/export')).body;
    assert.equal((await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
    assert.deepEqual(await read(), before, 'every reference points at the restored row');
    assert.equal((await client.get(`/api/vehicles/${veh}`)).status, 404, 'ids were regenerated');
    void util;

    // The same backup restored into another book resolves within that book.
    const other = await registerUser(base);
    assert.equal((await other.client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(other.bookId)]);
    const theirs = await (async () => {
      const one = async (sql: string) => (await db.query(sql, [other.bookId])).rows;
      return {
        tag: await one(`SELECT v.name FROM line_tags lt JOIN vehicles v ON v.id = lt.ref_id AND v.book_id = lt.book_id WHERE lt.book_id = $1`),
        cat: await one(`SELECT u.name FROM categories c JOIN utility_accounts u ON u.id = c.source_id AND u.book_id = c.book_id WHERE c.book_id = $1 AND c.managed AND c.source_kind = 'utility'`),
      };
    })();
    assert.deepEqual(theirs, { tag: [{ name: 'Blue Car' }], cat: [{ name: 'City Power' }] });
  } finally {
    await db.end();
  }
});

test('snapshot: stored-snapshot preview, corruption handling, and delete', async () => {
  const { client, bookId } = await registerUser(base);
  await client.post('/api/accounts', { name: 'A', type: 'checking' });
  await client.post('/api/backup/snapshots', { name: 'snap' });
  const snap = (await listSnaps(client))[0];

  // Preview a stored snapshot (no writes).
  const pv = await client.post(`/api/backup/snapshots/${snap.id}/preview`, {});
  assert.equal(pv.status, 200);
  assert.ok(pv.body.total_rows >= 1);

  // A non-integer id → 400.
  assert.equal((await client.post('/api/backup/snapshots/notanumber/preview', {})).status, 400);
  // A missing snapshot → 404.
  assert.equal((await client.post('/api/backup/snapshots/999999/preview', {})).status, 404);

  // Corrupt the stored blob → preview/restore report 422.
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`UPDATE backup_snapshots SET data = $1 WHERE id = $2 AND book_id = $3`, [Buffer.from('not json'), snap.id, bookId]);
  } finally {
    await db.end();
  }
  const corrupt = await client.post(`/api/backup/snapshots/${snap.id}/preview`, {});
  assert.equal(corrupt.status, 422);

  // Delete it.
  assert.equal((await client.del(`/api/backup/snapshots/${snap.id}`)).status, 200);
  assert.equal((await listSnaps(client)).length, 0);
  // Delete with a bad id → 400.
  assert.equal((await client.del('/api/backup/snapshots/notanumber')).status, 400);
});

test('snapshot download validates id and 404s on missing', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.get('/api/backup/snapshots/notanumber/download')).status, 400);
  assert.equal((await client.get('/api/backup/snapshots/999999/download')).status, 404);
});

test('patch validates id and requires something to update', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/backup/snapshots', { name: 'x' });
  const snap = (await listSnaps(client))[0];
  // Nothing to update → 400.
  assert.equal((await client.raw('PATCH', `/api/backup/snapshots/${snap.id}`, {})).status, 400);
  // Bad id → 400.
  assert.equal((await client.raw('PATCH', '/api/backup/snapshots/notanumber', { name: 'y' })).status, 400);
});

test('schedule: defaults, saving, validation, and the due-backup sweep', async () => {
  const { client, bookId } = await registerUser(base);
  await client.post('/api/accounts', { name: 'A', type: 'checking' });

  // Default (no row yet) settings.
  const initial = (await client.get('/api/backup/schedule')).body;
  assert.equal(initial.enabled, false);
  assert.equal(initial.frequency, 'weekly');
  assert.equal(initial.groups, null);

  // Invalid start_at → 400.
  assert.equal((await client.post('/api/backup/schedule', { enabled: true, start_at: 'not-a-date' })).status, 400);

  // Enable a daily schedule that already started (so the sweep considers it due).
  const saved = await client.post('/api/backup/schedule', {
    enabled: true, frequency: 'daily', start_at: '2020-01-01T00:00', groups: ['accounts'],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.frequency, 'daily');
  assert.deepEqual(saved.body.groups, ['accounts']);

  // An unknown frequency falls back to weekly; empty groups → null (full snapshot).
  const reSaved = await client.post('/api/backup/schedule', { enabled: true, frequency: 'hourly', groups: [] });
  assert.equal(reSaved.body.frequency, 'weekly');
  assert.equal(reSaved.body.groups, null);

  // Re-enable the started daily schedule, then run the sweep — it should store a
  // scheduled snapshot for this book and stamp last_backup_at.
  await client.post('/api/backup/schedule', { enabled: true, frequency: 'daily', start_at: '2020-01-01T00:00' });
  await runDueBackupsSafe();

  const snaps = await listSnaps(client);
  const auto = snaps.find((s: any) => s.label === 'auto');
  assert.ok(auto, 'the scheduled sweep created an auto snapshot');
  const after = (await client.get('/api/backup/schedule')).body;
  assert.ok(after.last_backup_at, 'last_backup_at was stamped');

  // Running the sweep again does nothing new (already backed up this period).
  await runDueBackupsSafe();
  const autoCount = (await listSnaps(client)).filter((s: any) => s.label === 'auto').length;
  assert.equal(autoCount, 1, 'no duplicate scheduled snapshot within the period');

  // Clean up so this book's enabled schedule doesn't linger in the shared DB.
  await client.post('/api/backup/schedule', { enabled: false });
  void bookId;
});

test('a required link the restore can\'t resolve stops it (never a silently missing record)', async () => {
  // Codex's case: a transactions-only backup with a vehicle tag, restored into a book
  // without that vehicle. The tag's vehicle link is required, so the restore refuses.
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body.id;
  await client.post('/api/transactions', { amount: 30, account_id: acct, direction: 'expense', txn_date: '2026-06-01', tags: [{ kind: 'vehicle', ref_id: veh }] });
  const env = (await client.get('/api/backup/export?groups=transactions')).body;

  const other = await registerUser(base);
  await other.client.post('/api/transactions', { amount: 1, direction: 'expense', txn_date: '2026-06-01', merchant: 'Keep Me' });
  const pv = (await other.client.post('/api/backup/preview', env)).body;
  assert.match(pv.problems.join(' '), /depends on data sets that aren't in the backup or this book: Vehicles \(1\)/);
  const imp = await other.client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
  assert.equal(imp.status, 400);
  assert.match(imp.body.error, /Vehicles/);
  const txns = (await other.client.get('/api/transactions')).body.posted;
  assert.deepEqual(txns.map((t: any) => t.merchant), ['Keep Me'], 'nothing changed');

  // In its own book the vehicle exists, so the tag survives.
  assert.equal((await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);
  const db = testDbClient();
  await db.connect();
  try {
    const tags = (await db.query(`SELECT kind, ref_id FROM line_tags WHERE book_id = $1`, [bookId])).rows;
    assert.deepEqual(tags, [{ kind: 'vehicle', ref_id: veh }]);
  } finally {
    await db.end();
  }
});

test('a write that arrives during a restore waits for it, and can\'t slip past the safety check', async () => {
  // Codex's case: a transaction added to an account between the restore's check and
  // its replace of Accounts. The restore now holds the book's other work off from
  // before its check until it commits.
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const env = (await client.get('/api/backup/export?groups=accounts')).body;
  const other = await registerUser(base);

  let write: Promise<any> | null = null;
  let finished = false;
  try {
    restoreTestHooks.afterLock = async () => {
      write = client.post('/api/transactions', { amount: 5, account_id: acct, direction: 'expense', txn_date: '2026-06-01' })
        .then((r: any) => { finished = true; return r; });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(finished, false, 'a write to this book waits while the restore runs');
      // Other books carry on.
      assert.equal((await other.client.post('/api/accounts', { name: 'Elsewhere', type: 'checking' })).status, 201);
    };
    const imp = await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
    assert.equal(imp.status, 200);
    // Once the restore commits, the write goes ahead and finds its account replaced,
    // instead of leaving a transaction with no account.
    const r = await write!;
    assert.ok(r.status >= 400 && r.status < 500, `the late write is refused (got ${r.status})`);
  } finally {
    restoreTestHooks.afterLock = undefined;
  }
  const db = testDbClient();
  await db.connect();
  try {
    const orphans = (await db.query(`SELECT count(*)::int AS c FROM transactions WHERE book_id = $1 AND account_id IS NULL`, [bookId])).rows[0].c;
    assert.equal(orphans, 0);
  } finally {
    await db.end();
  }
});
