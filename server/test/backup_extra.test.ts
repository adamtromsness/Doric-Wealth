import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { runDueBackupsSafe } from '../src/routes/backup.js';

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

  // Export ONLY the budgets group. budget_lines.category_id FKs to categories and is
  // NOT NULL, so a restore can neither remap it (categories aren't in the backup) nor
  // drop it. The pre-flight must refuse before anything is wiped.
  const env = (await client.get('/api/backup/export?groups=budgets')).body;
  const imp = await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
  assert.equal(imp.status, 400);
  assert.match(imp.body.error, /depends on data sets/);
  assert.match(imp.body.error, /Categories/i);
});

test('selective restore nulls a nullable link whose parent is not in the backup', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-01' });

  // transactions.account_id is nullable, so restoring transactions alone is allowed —
  // the unmappable link is dropped rather than rejected.
  const env = (await client.get('/api/backup/export?groups=transactions')).body;
  const imp = await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
  assert.equal(imp.status, 200);
  const txns = (await client.get('/api/transactions')).body.posted;
  assert.equal(txns.length, 1);
  assert.equal(txns[0].account_id, null, 'the unmappable account link was dropped');
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
