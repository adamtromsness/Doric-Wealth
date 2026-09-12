import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const listSnaps = async (client: any) => (await client.get('/api/backup/snapshots')).body;

test('create-now stores a named snapshot that can be listed and downloaded', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 100 });

  const made = await client.post('/api/backup/snapshots', { name: 'First' });
  assert.equal(made.status, 200);

  const { snapshots, max } = await listSnaps(client);
  assert.equal(max, 5);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].name, 'First');
  assert.equal(snapshots[0].label, 'manual');
  assert.equal(snapshots[0].pinned, false);
  assert.equal(snapshots[0].scope, 'full', 'no group filter → full snapshot');
  assert.ok(snapshots[0].taken_at, 'records a capture time');
  assert.ok(snapshots[0].bytes > 0);

  // A group-filtered snapshot is marked partial.
  await client.post('/api/backup/snapshots', { name: 'Just accounts', groups: ['accounts'] });
  const partial = (await listSnaps(client)).snapshots.find((s: any) => s.name === 'Just accounts');
  assert.equal(partial.scope, 'partial', 'a group-filtered snapshot is partial');

  const dl = await client.get(`/api/backup/snapshots/${snapshots[0].id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.app, 'doric');
  assert.ok(dl.body.tables.accounts.length >= 1);
});

test('the 5-snapshot cap auto-purges the oldest unpinned snapshot', async () => {
  const { client } = await registerUser(base);
  for (let i = 0; i < 6; i++) {
    const r = await client.post('/api/backup/snapshots', { name: `snap-${i}` });
    assert.equal(r.status, 200);
  }
  const { snapshots } = await listSnaps(client);
  assert.equal(snapshots.length, 5, 'never exceeds the cap');
  const names = snapshots.map((s: any) => s.name);
  assert.ok(!names.includes('snap-0'), 'the oldest snapshot was purged');
  assert.ok(names.includes('snap-5'), 'the newest snapshot is kept');
});

test('keeping is capped at 4 — pinning a 5th unpins the oldest', async () => {
  const { client } = await registerUser(base);
  // s0 is the oldest, s4 the newest (sequential creation → increasing taken_at).
  for (let i = 0; i < 5; i++) await client.post('/api/backup/snapshots', { name: `s${i}` });
  const byName = (xs: any[], n: string) => xs.find((s) => s.name === n);

  // Pin the four oldest — all allowed.
  for (const n of ['s0', 's1', 's2', 's3']) {
    const snap = byName((await listSnaps(client)).snapshots, n);
    const p = await client.raw('PATCH', `/api/backup/snapshots/${snap.id}`, { pinned: true });
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.unpinned, [], 'within the limit, nothing is auto-unpinned');
  }

  // Pinning a 5th exceeds the cap → the oldest (s0) is auto-unpinned, not the new one.
  const s4 = byName((await listSnaps(client)).snapshots, 's4');
  const fifth = await client.raw('PATCH', `/api/backup/snapshots/${s4.id}`, { pinned: true });
  assert.equal(fifth.status, 200);
  assert.deepEqual(fifth.body.unpinned, ['s0'], 'the oldest pinned snapshot was de-selected');

  const after = (await listSnaps(client)).snapshots;
  assert.equal(after.filter((s: any) => s.pinned).length, 4, 'never more than four kept');
  assert.equal(byName(after, 's0').pinned, false, 's0 was unpinned');
  assert.equal(byName(after, 's4').pinned, true, 'the just-pinned snapshot stays pinned');

  // An unpinned slot always remains, so creating a new snapshot still succeeds.
  const ok = await client.post('/api/backup/snapshots', { name: 'fresh' });
  assert.equal(ok.status, 200);
  assert.equal((await listSnaps(client)).snapshots.length, 5);
});

test('rename updates a snapshot name', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/backup/snapshots', { name: 'Old' });
  const id = (await listSnaps(client)).snapshots[0].id;
  const r = await client.raw('PATCH', `/api/backup/snapshots/${id}`, { name: 'Renamed' });
  assert.equal(r.status, 200);
  assert.equal((await listSnaps(client)).snapshots[0].name, 'Renamed');
});

test('restore from a stored snapshot replaces current data', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'Original', type: 'checking', opening_balance: 0 });

  // Snapshot captures only "Original".
  await client.post('/api/backup/snapshots', { name: 'baseline' });
  const id = (await listSnaps(client)).snapshots[0].id;

  // Add a second account that is NOT in the snapshot.
  await client.post('/api/accounts', { name: 'Added Later', type: 'savings', opening_balance: 0 });
  assert.equal((await client.get('/api/accounts')).body.length, 2);

  // Preview reports what the snapshot contains; restore requires the confirm token.
  const pv = await client.post(`/api/backup/snapshots/${id}/preview`, {});
  assert.equal(pv.status, 200);
  assert.ok(pv.body.total_rows >= 1);
  assert.equal((await client.post(`/api/backup/snapshots/${id}/restore`, {})).status, 400, 'restore needs confirm');

  const done = await client.post(`/api/backup/snapshots/${id}/restore`, { confirm: 'REPLACE' });
  assert.equal(done.status, 200);

  const accts = (await client.get('/api/accounts')).body;
  assert.equal(accts.length, 1, 'restore replaced the accounts data set');
  assert.equal(accts[0].name, 'Original');
});

test('uploading a snapshot file adds it to the list without restoring', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'Keep Me', type: 'checking', opening_balance: 0 });

  // Grab a real envelope by creating then downloading a snapshot.
  await client.post('/api/backup/snapshots', { name: 'seed' });
  const seedId = (await listSnaps(client)).snapshots[0].id;
  const env = (await client.get(`/api/backup/snapshots/${seedId}/download`)).body;

  // Pretend the file was created two years ago — the list should show THAT time.
  env.exported_at = '2024-02-03T08:30:00.000Z';

  // Upload it back as a separate, named entry.
  const up = await client.post('/api/backup/snapshots/upload', { name: 'Imported', envelope: env });
  assert.equal(up.status, 200);

  const { snapshots } = await listSnaps(client);
  assert.equal(snapshots.length, 2, 'upload added a second snapshot');
  const uploaded = snapshots.find((s: any) => s.name === 'Imported');
  assert.ok(uploaded, 'the uploaded snapshot is listed');
  assert.equal(uploaded.label, 'upload');
  assert.equal(uploaded.scope, 'full', 'a whole-dataset upload is marked full');
  assert.equal(new Date(uploaded.taken_at).toISOString(), '2024-02-03T08:30:00.000Z', 'shows the original creation time, not the upload time');

  // Upload must NOT restore — current data is untouched.
  assert.equal((await client.get('/api/accounts')).body.length, 1, 'upload did not replace live data');

  // A non-backup file is rejected.
  assert.equal((await client.post('/api/backup/snapshots/upload', { name: 'bad', envelope: { nope: true } })).status, 400);
});

test('purge previews and deletes by DB-creation date range', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/accounts', { name: 'Acct', type: 'checking', opening_balance: 0 });

  // A clearly-past window matches nothing the freshly-created rows fall into.
  const past = await client.post('/api/backup/purge/preview', { groups: ['accounts'], from: '2000-01-01', to: '2000-12-31' });
  assert.equal(past.status, 200);
  assert.equal(past.body.total_rows, 0, 'rows created today are not in a year-2000 window');

  // A window spanning all of time includes the just-created account row.
  const wide = await client.post('/api/backup/purge/preview', { groups: ['accounts'], from: '2000-01-01', to: '2999-01-01' });
  assert.ok(wide.body.total_rows >= 1, 'preview counts current rows');

  // Purging the past window deletes nothing — the account survives.
  const noop = await client.post('/api/backup/purge', { groups: ['accounts'], from: '2000-01-01', to: '2000-12-31', confirm: 'DELETE' });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.deleted_rows, 0);
  assert.equal((await client.get('/api/accounts')).body.length, 1, 'out-of-range purge left the account');

  // Purging the all-time window removes it.
  const done = await client.post('/api/backup/purge', { groups: ['accounts'], from: '2000-01-01', to: '2999-01-01', confirm: 'DELETE' });
  assert.equal(done.status, 200);
  assert.ok(done.body.deleted_rows >= 1);
  assert.equal((await client.get('/api/accounts')).body.length, 0, 'in-range purge removed the account');
});

test('purge validates confirm, group selection, and date order', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/backup/purge', { groups: ['accounts'] })).status, 400, 'needs confirm');
  assert.equal((await client.post('/api/backup/purge', { groups: [], confirm: 'DELETE' })).status, 400, 'needs a data set');
  assert.equal((await client.post('/api/backup/purge/preview', { groups: ['accounts'], from: '2026-12-31', to: '2026-01-01' })).status, 400, 'from must precede to');
  assert.equal((await client.post('/api/backup/purge/preview', { groups: ['accounts'], from: 'nope' })).status, 400, 'bad date form');
});

// GET /api/backup/export streams the envelope to the response piece by piece (it does
// NOT build one in-memory string, to avoid OOM on large books). These prove the
// streamed assembly — commas between rows, between tables, and empty tables — is valid,
// complete JSON that still round-trips through import.
async function seedExportBook() {
  const { client } = await registerUser(base);
  const a1 = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const a2 = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  await client.post('/api/transactions', { amount: 10, account_id: a1, direction: 'expense', txn_date: '2026-06-01', category_id: cat });
  await client.post('/api/transactions', { amount: 20, account_id: a1, direction: 'income', txn_date: '2026-06-02' });
  await client.post('/api/transactions', { amount: 30, account_id: a2, direction: 'expense', txn_date: '2026-06-03', category_id: cat });
  return { client };
}

test('streamed export is valid JSON across many tables and rows', async () => {
  const { client } = await seedExportBook();
  const exp = await client.get('/api/backup/export');
  assert.equal(exp.status, 200);
  const env = exp.body; // the client parsed the streamed body — that alone proves valid JSON
  assert.equal(env.app, 'doric');
  assert.equal(env.format_version, 1);
  assert.ok(env.tables && typeof env.tables === 'object', 'has a tables map');
  assert.equal(env.tables.accounts.length, 2);     // multiple rows
  assert.equal(env.tables.transactions.length, 3); // multiple rows, different table
  assert.equal(env.tables.categories.length, 1);
  assert.ok(Array.isArray(env.tables.vehicles) && env.tables.vehicles.length === 0, 'empty table present as []');
});

test('streamed export round-trips through import (REPLACE)', async () => {
  const { client } = await seedExportBook();
  const env = (await client.get('/api/backup/export')).body;
  const imp = await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' });
  assert.equal(imp.status, 200);
  assert.ok(imp.body.restored_rows >= 6, `restored ${imp.body.restored_rows} rows`);
  assert.equal((await client.get('/api/accounts')).body.length, 2);
  const txns = (await client.get('/api/transactions')).body;
  assert.equal(txns.total + txns.pendingTotal, 3);
});

test('selective streamed export includes only the selected groups', async () => {
  const { client } = await seedExportBook();
  const env = (await client.get('/api/backup/export?groups=transactions')).body;
  assert.equal(env.app, 'doric');
  assert.equal(env.tables.transactions.length, 3);
  assert.equal(env.tables.accounts, undefined, 'a non-selected group is absent entirely');
});

test('restore remaps self-referential ids (category hierarchy) through the chunked insert', async () => {
  const { client } = await registerUser(base);
  const group = (await client.post('/api/categories', { name: 'Housing', kind: 'expense' })).body.id;
  await client.post('/api/categories', { name: 'Rent', kind: 'expense', parent_id: group });
  await client.post('/api/categories', { name: 'Utilities', kind: 'expense', parent_id: group });

  const env = (await client.get('/api/backup/export')).body;
  assert.equal((await client.post('/api/backup/import', { ...env, confirm: 'REPLACE' })).status, 200);

  // After restore every id is freshly assigned; the children must still point at the
  // (newly-assigned) parent id, proving the self-ref second pass remapped correctly.
  const cats = (await client.get('/api/categories')).body as any[];
  const housing = cats.find((c) => c.name === 'Housing');
  const rent = cats.find((c) => c.name === 'Rent');
  const utilities = cats.find((c) => c.name === 'Utilities');
  assert.ok(housing && rent && utilities, 'all three categories survived the restore');
  assert.equal(housing.parent_id ?? null, null, 'the group stays top-level');
  assert.equal(rent.parent_id, housing.id, 'Rent points at the remapped Housing id');
  assert.equal(utilities.parent_id, housing.id, 'Utilities points at the remapped Housing id');
});
