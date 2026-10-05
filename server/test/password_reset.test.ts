import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startServer, stopServer, registerUser, makeClient, login, testDbClient } from './helpers.js';
import { TEST_DATABASE_URL } from './config.js';
import { config } from '../src/config.js';
import { setMailSenderForTests, type Mail } from '../src/mailer.js';
import { runCli, maskEmail } from '../src/passwordReset.js';

let base: string;
let pool: pg.Pool;
before(async () => { base = await startServer(); pool = new pg.Pool({ connectionString: TEST_DATABASE_URL }); });
after(async () => { await pool.end(); await stopServer(); });
afterEach(() => { setMailSenderForTests(null); config.appBaseUrl = ''; });

let sent: Mail[] = [];
function captureMail() {
  sent = [];
  setMailSenderForTests(async (m) => { sent.push(m); });
  config.appBaseUrl = 'https://doric.example';
}
const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)![1];
const request = (email: string) => makeClient(base).post('/api/auth/password-reset/request', { email });

async function sql(text: string, params: any[] = []) {
  const db = testDbClient(); await db.connect();
  try { return (await db.query(text, params)).rows; } finally { await db.end(); }
}

test('without email set up, the user is told to ask the operator and no mail is sent', async () => {
  const { email } = await registerUser(base);
  const r = await request(email);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, email_enabled: false });
  assert.equal((await sql(`SELECT count(*)::int AS c FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = $1`, [email]))[0].c, 0);
});

test('with email set up, a link is emailed for a real account; an unknown one gets the same reply', async () => {
  const { email } = await registerUser(base);
  captureMail();
  const known = await request(email.toUpperCase());
  const unknown = await request('nobody-here@example.com');
  assert.deepEqual(known.body, { ok: true, email_enabled: true });
  assert.deepEqual(unknown.body, known.body, 'same response, so it does not reveal accounts');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, email);
  assert.equal(sent[0].subject, 'Reset your Doric password');
  assert.match(sent[0].text, /https:\/\/doric\.example\/reset-password\?token=[\w-]{40,}/);
  assert.equal((await request('not an email')).status, 400);
});

test('a reset link sets a new password, signs out everywhere, and works only once', async () => {
  const { client, email } = await registerUser(base);
  captureMail();
  await request(email);
  const token = tokenFrom(sent[0].text);

  const check = await makeClient(base).get(`/api/auth/password-reset/${token}`);
  assert.equal(check.status, 200);
  assert.equal(check.body.email, maskEmail(email));
  assert.ok(!check.body.email.includes(email.split('@')[0]), 'the email is masked');

  const anon = makeClient(base);
  assert.equal((await anon.post('/api/auth/password-reset/complete', { token, password: 'short' })).status, 400);
  const done = await anon.post('/api/auth/password-reset/complete', { token, password: 'brand-new-password' });
  assert.equal(done.status, 200);

  // The existing session was ended; the new password works and the old one doesn't.
  assert.equal((await client.get('/api/auth/me')).status, 401);
  await assert.rejects(login(base, email, 'supersecret'));
  assert.ok(await login(base, email, 'brand-new-password'));

  // Used up.
  assert.equal((await anon.post('/api/auth/password-reset/complete', { token, password: 'another-password' })).status, 400);
  assert.equal((await anon.get(`/api/auth/password-reset/${token}`)).status, 404);
});

test('expired links and links replaced by a newer one are refused', async () => {
  const { email } = await registerUser(base);
  captureMail();
  await request(email);
  const first = tokenFrom(sent[0].text);
  await request(email);
  const second = tokenFrom(sent[1].text);
  const anon = makeClient(base);
  assert.equal((await anon.get(`/api/auth/password-reset/${first}`)).status, 404, 'replaced by the newer link');
  assert.equal((await anon.get(`/api/auth/password-reset/${second}`)).status, 200);

  await sql(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
  assert.equal((await anon.post('/api/auth/password-reset/complete', { token: second, password: 'brand-new-password' })).status, 400);
  assert.equal((await anon.get('/api/auth/password-reset/not-a-real-token')).status, 404);
});

test('the operator command creates a 24-hour link for an account', async () => {
  const { email } = await registerUser(base);
  config.appBaseUrl = 'https://doric.example';
  const out: string[] = [];
  await runCli([email], pool, (s) => out.push(s));
  assert.match(out.join('\n'), /valid for 24 hours and one use/);
  const token = tokenFrom(out.join('\n'));
  const row = (await sql(`SELECT via, expires_at > now() + interval '23 hours' AS long FROM password_resets WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]))[0];
  assert.deepEqual(row, { via: 'admin', long: true });
  assert.equal((await makeClient(base).post('/api/auth/password-reset/complete', { token, password: 'operator-reset-pw' })).status, 200);

  await assert.rejects(runCli(['nobody@example.com'], pool, () => {}), /No account/);
  await assert.rejects(runCli([email, '--hours', '0'], pool, () => {}), /--hours/);
  await assert.rejects(runCli([], pool, () => {}), /Usage/);
});

test('maskEmail keeps the domain and hides most of the name', () => {
  assert.equal(maskEmail('adam@example.com'), 'ad••@example.com');
  assert.equal(maskEmail('jo@example.com'), 'j•@example.com');
  assert.equal(maskEmail('a@x.io'), 'a•@x.io');
});
