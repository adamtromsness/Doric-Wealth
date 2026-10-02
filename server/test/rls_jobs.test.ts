// Background jobs under a RESTRICTED database role (like production), where row-level
// security is enforced. Jobs run outside any HTTP request, so they must set the tenant
// context themselves; under the privileged test role a missing context goes unnoticed.
process.env.TEST_RESTRICTED_ROLE = '1';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { startServer, stopServer, registerUser, RESTRICTED } = await import('./helpers.js');
const { runDueBackupsSafe } = await import('../src/routes/backup.js');
const { pool } = await import('../src/db.js');

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('the app connects as a restricted role in this file', async () => {
  assert.equal(RESTRICTED, true);
  const r = (await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false });
});

test('a scheduled backup captures the book and restores into another book intact', async () => {
  const { client } = await registerUser(base);
  const checking = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 1000 })).body.id;
  await client.post('/api/accounts', { name: 'Savings', type: 'savings', opening_balance: 5000 });
  await client.post('/api/transactions', { amount: 125.5, account_id: checking, direction: 'expense', txn_date: '2026-09-15' });
  const before = (await client.get('/api/accounts')).body.map((a: any) => [a.name, Number(a.balance)]).sort();

  // Due now: started yesterday, never run.
  const start = new Date(Date.now() - 86_400_000).toISOString().slice(0, 16);
  assert.equal((await client.post('/api/backup/schedule', { enabled: true, frequency: 'daily', start_at: start })).status, 200);

  await runDueBackupsSafe();

  const { snapshots } = (await client.get('/api/backup/snapshots')).body;
  const auto = snapshots.filter((s: any) => s.label === 'auto');
  assert.equal(auto.length, 1, 'the scheduler found the enabled schedule and stored a snapshot');
  const env = (await client.get(`/api/backup/snapshots/${auto[0].id}/download`)).body;
  assert.equal(env.tables.accounts.length, 2, 'snapshot contains both accounts');
  assert.equal(env.tables.transactions.length, 1, 'snapshot contains the transaction');
  assert.ok((await client.get('/api/backup/schedule')).body.last_backup_at, 'last_backup_at recorded');

  // A second sweep in the same period does nothing.
  await runDueBackupsSafe();
  assert.equal((await client.get('/api/backup/snapshots')).body.snapshots.filter((s: any) => s.label === 'auto').length, 1);

  // Restore into a different, empty book and compare balances.
  const other = await registerUser(base);
  const up = await other.client.post('/api/backup/snapshots/upload', { name: 'From scheduled', envelope: env });
  assert.equal(up.status, 200);
  const done = await other.client.post(`/api/backup/snapshots/${up.body.id}/restore`, { confirm: 'REPLACE' });
  assert.equal(done.status, 200);
  const after = (await other.client.get('/api/accounts')).body.map((a: any) => [a.name, Number(a.balance)]).sort();
  assert.deepEqual(after, before);
});
