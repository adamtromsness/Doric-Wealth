import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, makeClient, uniqueEmail } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('register validates required fields, email format, and password length', async () => {
  const c = makeClient(base);
  // Missing email/password → 400 (require_).
  assert.equal((await c.post('/api/auth/register', {})).status, 400);
  // Bad email → 400.
  const badEmail = await c.post('/api/auth/register', { email: 'not-an-email', password: 'supersecret' });
  assert.equal(badEmail.status, 400);
  assert.match(badEmail.body.error, /valid email/i);
  // Short password → 400.
  const shortPw = await c.post('/api/auth/register', { email: uniqueEmail(), password: 'short' });
  assert.equal(shortPw.status, 400);
  assert.match(shortPw.body.error, /at least 8/i);
});

test('register defaults the book name from the user name/email when omitted', async () => {
  // With a name, no book_name → "<name>'s Book".
  const named = makeClient(base);
  const email = uniqueEmail();
  const r1 = await named.post('/api/auth/register', { email, password: 'supersecret', name: 'Casey' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.activeBook.name, "Casey's Book");

  // Without a name, no book_name → "<email-local-part>'s Book".
  const anon = makeClient(base);
  const email2 = `bookless-${Date.now().toString(36)}@test.local`;
  const r2 = await anon.post('/api/auth/register', { email: email2, password: 'supersecret' });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.activeBook.name, `${email2.split('@')[0]}'s Book`);
});

test('register rejects a duplicate email (case-insensitive) with 409', async () => {
  const email = uniqueEmail();
  const first = makeClient(base);
  assert.equal((await first.post('/api/auth/register', { email, password: 'supersecret' })).status, 201);
  const second = makeClient(base);
  const dup = await second.post('/api/auth/register', { email: email.toUpperCase(), password: 'supersecret' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already exists/i);
});

test('login: unknown user and wrong password both give a generic 401', async () => {
  const { email } = await registerUser(base);
  // Unknown user.
  const noUser = makeClient(base);
  const r1 = await noUser.post('/api/auth/login', { email: uniqueEmail(), password: 'supersecret' });
  assert.equal(r1.status, 401);
  assert.match(r1.body.error, /incorrect/i);
  // Wrong password for a real user (exercises verifyPassword's mismatch path).
  const wrongPw = makeClient(base);
  const r2 = await wrongPw.post('/api/auth/login', { email, password: 'wrong-password-here' });
  assert.equal(r2.status, 401);
  // Missing fields → 400.
  assert.equal((await makeClient(base).post('/api/auth/login', {})).status, 400);
});

test('login succeeds and resolves the first book as active', async () => {
  const { email, bookId } = await registerUser(base);
  const c = makeClient(base);
  const r = await c.post('/api/auth/login', { email, password: 'supersecret' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, email);
  assert.equal(r.body.activeBook.id, bookId, 'active book = lowest-id membership');
  // The returned session cookie is valid.
  assert.equal((await c.get('/api/auth/me')).status, 200);
});

test('logout is a no-op when there is no session cookie', async () => {
  const anon = makeClient(base);
  // No session → still 204, and no crash in destroySession (guarded by sessionToken).
  assert.equal((await anon.post('/api/auth/logout')).status, 204);
});

test('GET /auth/me requires authentication', async () => {
  const anon = makeClient(base);
  const r = await anon.get('/api/auth/me');
  assert.equal(r.status, 401);
  assert.match(r.body.error, /authentication required/i);
});

test('an expired/garbage session cookie is treated as anonymous', async () => {
  const anon = makeClient(base);
  anon.cookie = 'ft_session=totally-bogus-token';
  // authContext finds no matching session → req.user undefined → requireAuth 401.
  assert.equal((await anon.get('/api/auth/me')).status, 401);
});
