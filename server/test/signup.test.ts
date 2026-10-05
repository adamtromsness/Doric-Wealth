import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  startServer, stopServer, registerUser, makeClient, uniqueEmail,
  createDatabase, dropDatabase, applyMigrations,
} from './helpers.js';
import { TEST_DATABASE_URL } from './config.js';
import { config } from '../src/config.js';
import { run as inviteCli } from '../src/signupInvites.js';

let base: string;
let pool: pg.Pool;
before(async () => {
  base = await startServer();
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});
after(async () => {
  config.signupMode = 'open';
  await pool.end();
  await stopServer();
});

// Run the invite CLI against the test database and return what it printed.
async function cli(...argv: string[]): Promise<string[]> {
  const out: string[] = [];
  await inviteCli(argv, pool, (s) => out.push(s));
  return out;
}

// Create a signup invite through the CLI and return its code (taken from the link).
async function createSignupCode(...flags: string[]): Promise<{ id: number; code: string }> {
  const out = await cli('create', ...flags);
  const id = Number(/#(\d+)/.exec(out[0])![1]);
  const code = /[?&]code=([\w-]+)/.exec(out.join('\n'))![1];
  return { id, code };
}

async function inviteOnly<T>(fn: () => Promise<T>): Promise<T> {
  config.signupMode = 'invite';
  try { return await fn(); } finally { config.signupMode = 'open'; }
}

const register = (body: Record<string, unknown>) =>
  makeClient(base).post('/api/auth/register', { password: 'supersecret', ...body });

test('signup-config reports the mode', async () => {
  await registerUser(base); // the database may be empty when this runs first
  const c = makeClient(base);
  assert.deepEqual((await c.get('/api/auth/signup-config')).body, { invite_only: false, first_account: false, contact_email: null });
  await inviteOnly(async () => {
    assert.equal((await c.get('/api/auth/signup-config')).body.invite_only, true);
  });
});

test('invite-only: registering without a code is refused once accounts exist', async () => {
  await registerUser(base); // ensure the database isn't empty
  await inviteOnly(async () => {
    const r = await register({ email: uniqueEmail() });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /by invitation only/);
  });
});

test('a signup invite creates an account with its own book, once', async () => {
  const { code } = await createSignupCode('--note', 'test');
  await inviteOnly(async () => {
    const email = uniqueEmail();
    const r = await register({ email, invite_code: code, book_name: 'Invited Book' });
    assert.equal(r.status, 201);
    assert.equal(r.body.activeBook.name, 'Invited Book');
    assert.equal(r.body.activeBook.role, 'owner');

    const again = await register({ email: uniqueEmail(), invite_code: code });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /invalid, expired, or already used/);

    const listed = (await cli('list')).join('\n');
    assert.match(listed, new RegExp(`used \\d{4}-\\d{2}-\\d{2} by ${email.replace(/[.+]/g, '\\$&')}`));
  });
});

test('an email-locked signup invite only works for that email (case-insensitive)', async () => {
  const email = uniqueEmail('locked');
  const { code } = await createSignupCode('--email', email);
  const wrong = await register({ email: uniqueEmail(), invite_code: code });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /different email/);
  const right = await register({ email: email.toUpperCase(), invite_code: code });
  assert.equal(right.status, 201);
});

test('revoked and expired signup invites are refused', async () => {
  const revoked = await createSignupCode();
  assert.match((await cli('revoke', String(revoked.id))).join(''), /Revoked/);
  assert.equal((await register({ email: uniqueEmail(), invite_code: revoked.code })).status, 400);

  const expired = await createSignupCode('--days', '1');
  await pool.query(`UPDATE signup_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.id]);
  assert.equal((await register({ email: uniqueEmail(), invite_code: expired.code })).status, 400);
  assert.match((await cli('list')).join('\n'), new RegExp(`#${expired.id} .*expired`));
});

test('an unknown code is refused, in either mode', async () => {
  assert.equal((await register({ email: uniqueEmail(), invite_code: 'not-a-real-code' })).status, 400);
  await inviteOnly(async () => {
    assert.equal((await register({ email: uniqueEmail(), invite_code: 'not-a-real-code' })).status, 400);
  });
});

test('a book invite works as a sign-up code and joins that book without creating another', async () => {
  const owner = await registerUser(base, { book_name: 'Family Book' });
  const inv = (await owner.client.post(`/api/books/${owner.bookId}/invites`, { role: 'member', max_uses: 1 })).body;

  await inviteOnly(async () => {
    const r = await register({ email: uniqueEmail(), invite_code: inv.code, book_name: 'Ignored' });
    assert.equal(r.status, 201);
    assert.equal(r.body.activeBook.id, owner.bookId);
    assert.equal(r.body.activeBook.role, 'member');
    assert.deepEqual(r.body.books.map((b: any) => b.id), [owner.bookId]);

    // max_uses = 1, so it's now used up.
    assert.equal((await register({ email: uniqueEmail(), invite_code: inv.code })).status, 400);
  });
  const uses = (await pool.query(`SELECT uses FROM invites WHERE id = $1`, [inv.id])).rows[0].uses;
  assert.equal(uses, 1);
});

test('invite CLI validates its input', async () => {
  await assert.rejects(cli('create', '--email', 'nope'), /valid email/);
  await assert.rejects(cli('create', '--days', '0'), /--days/);
  await assert.rejects(cli('create', '--note'), /needs a value/);
  await assert.rejects(cli('revoke', 'x'), /Usage: revoke/);
  await assert.rejects(cli('revoke', '999999'), /not found/);
  await assert.rejects(cli('bogus'), /Usage/);
});

// The first account on an empty database needs no code. That needs an empty database,
// so it runs a separate server process against a throwaway one.
test('invite-only: the first account on an empty database needs no code; the second does', async () => {
  const dbName = 'finance_test_signup_empty';
  const url = await createDatabase(dbName);
  let child: ChildProcess | undefined;
  try {
    await applyMigrations(url);
    const port = 41000 + Math.floor(Math.random() * 2000);
    const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: url, APP_DATABASE_URL: url, PORT: String(port), HOST: '127.0.0.1', SIGNUP_MODE: 'invite', SERVER_NO_LISTEN: '' },
      stdio: 'ignore',
    });
    const childBase = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${childBase}/api/health`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const c = makeClient(childBase);
    assert.deepEqual((await c.get('/api/auth/signup-config')).body, { invite_only: true, first_account: true, contact_email: null });
    const first = await c.post('/api/auth/register', { email: uniqueEmail('first'), password: 'supersecret' });
    assert.equal(first.status, 201);
    assert.equal((await c.get('/api/auth/signup-config')).body.first_account, false);
    const second = await makeClient(childBase).post('/api/auth/register', { email: uniqueEmail('second'), password: 'supersecret' });
    assert.equal(second.status, 403);
  } finally {
    child?.kill();
    await dropDatabase(dbName);
  }
});

test('privacy config states what this server is set up to do (signed out)', async () => {
  const c = makeClient(base);
  const saved = { appBaseUrl: config.appBaseUrl, backupKeepDays: config.backupKeepDays, offsiteBackups: config.offsiteBackups, contactEmail: config.contactEmail };
  try {
    Object.assign(config, { appBaseUrl: 'https://app.example.com', backupKeepDays: 30, offsiteBackups: true, contactEmail: 'help@example.com' });
    assert.deepEqual((await c.get('/api/auth/privacy')).body, { contact_email: 'help@example.com', https: true, backup_keep_days: 30, offsite_backups: true });
    Object.assign(config, { appBaseUrl: 'http://localhost:4100', backupKeepDays: null, offsiteBackups: false, contactEmail: '' });
    assert.deepEqual((await c.get('/api/auth/privacy')).body, { contact_email: null, https: false, backup_keep_days: null, offsite_backups: false });
  } finally {
    Object.assign(config, saved);
  }
});
