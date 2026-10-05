import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startServer, stopServer, registerUser } from './helpers.js';
import { TEST_DATABASE_URL } from './config.js';
import { runCli } from '../src/deleteAccount.js';

let base: string;
let pool: pg.Pool;
before(async () => { base = await startServer(); pool = new pg.Pool({ connectionString: TEST_DATABASE_URL }); });
after(async () => { await pool.end(); await stopServer(); });

async function cli(...argv: string[]): Promise<string> {
  const out: string[] = [];
  await runCli(argv, pool, (s) => out.push(s));
  return out.join('\n');
}
const count = async (sql: string, params: any[]) => (await pool.query(sql, params)).rows[0].c as number;

// Owner of a book shared with a member.
async function shared() {
  const owner = await registerUser(base, { book_name: 'Family' });
  const member = await registerUser(base, { book_name: 'Mine' });
  const code = (await owner.client.post(`/api/books/${owner.bookId}/invites`, {})).body.code;
  assert.equal((await member.client.post(`/api/invites/${encodeURIComponent(code)}/accept`)).status, 200);
  return { owner, member };
}

test('dry run by default: prints the plan and deletes nothing', async () => {
  const u = await registerUser(base);
  await u.client.post('/api/accounts', { name: 'Checking', type: 'checking' });
  const out = await cli(u.email);
  assert.match(out, /delete book "Test Book"/);
  assert.match(out, /Dry run/);
  assert.equal(await count(`SELECT count(*)::int AS c FROM users WHERE lower(email) = lower($1)`, [u.email]), 1);
});

test('--yes deletes the account, its own books and their data, and signs it out', async () => {
  const u = await registerUser(base);
  await u.client.post('/api/accounts', { name: 'Checking', type: 'checking' });
  const out = await cli(u.email, '--yes');
  assert.match(out, /1 book deleted/);
  assert.match(out, /backups still hold this data/);
  assert.equal(await count(`SELECT count(*)::int AS c FROM users WHERE lower(email) = lower($1)`, [u.email]), 0);
  assert.equal(await count(`SELECT count(*)::int AS c FROM books WHERE id = $1`, [u.bookId]), 0);
  assert.equal(await count(`SELECT count(*)::int AS c FROM accounts WHERE book_id = $1`, [u.bookId]), 0);
  assert.equal((await u.client.get('/api/auth/me')).status, 401);
});

test('a member of a shared book is removed from it; the book stays with the others', async () => {
  const { owner, member } = await shared();
  const out = await cli(member.email, '--yes');
  assert.match(out, /remove them from shared book "Family"/);
  assert.equal(await count(`SELECT count(*)::int AS c FROM books WHERE id = $1`, [owner.bookId]), 1);
  assert.equal(await count(`SELECT count(*)::int AS c FROM books WHERE id = $1`, [member.bookId]), 0, 'their own book is deleted');
  assert.equal(await count(`SELECT count(*)::int AS c FROM memberships WHERE book_id = $1`, [owner.bookId]), 1);
});

test('the only owner of a shared book: blocked unless another member takes it over', async () => {
  const { owner, member } = await shared();
  await assert.rejects(cli(owner.email, '--yes'), /Nothing was deleted.*--new-owner/);
  assert.equal(await count(`SELECT count(*)::int AS c FROM users WHERE lower(email) = lower($1)`, [owner.email]), 1);

  const out = await cli(owner.email, '--new-owner', member.email, '--yes');
  assert.match(out, /make .* the owner of shared book "Family"/);
  assert.equal(await count(`SELECT count(*)::int AS c FROM users WHERE lower(email) = lower($1)`, [owner.email]), 0);
  const roles = (await pool.query(`SELECT role FROM memberships WHERE book_id = $1`, [owner.bookId])).rows.map((r) => r.role);
  assert.deepEqual(roles, ['owner'], 'the member now owns the book');
});

test('validates its input', async () => {
  await assert.rejects(cli(), /Usage/);
  await assert.rejects(cli('nobody@example.com'), /No account/);
  const u = await registerUser(base);
  await assert.rejects(cli(u.email, '--new-owner'), /needs an email/);
  await assert.rejects(cli(u.email, '--new-owner', u.email), /someone else/);
  await assert.rejects(cli(u.email, '--new-owner', 'nobody@example.com'), /No account/);
});
