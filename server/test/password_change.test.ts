import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, login } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const change = (client: any, current: string, next: string) =>
  client.put('/api/auth/password', { current_password: current, new_password: next });

test('changes the password and lets the user sign in with the new one', async () => {
  const { client, email } = await registerUser(base);
  const res = await change(client, 'supersecret', 'brand-new-secret');
  assert.equal(res.status, 200);

  // The old password no longer works; the new one does.
  const stale = await login(base, email).catch(() => null);
  assert.equal(stale, null, 'the old password is rejected');
  const fresh = await login(base, email, 'brand-new-secret');
  assert.equal((await fresh.get('/api/auth/me')).status, 200);
});

test('revokes every other session but keeps the caller signed in', async () => {
  const { client, email } = await registerUser(base);
  const other = await login(base, email);
  const third = await login(base, email);

  const res = await change(client, 'supersecret', 'brand-new-secret');
  assert.equal(res.status, 200);
  assert.equal(res.body.ended, 2, 'both other sessions were ended');

  assert.equal((await client.get('/api/auth/me')).status, 200, 'the caller stays signed in');
  assert.equal((await other.get('/api/auth/me')).status, 401);
  assert.equal((await third.get('/api/auth/me')).status, 401);
});

test('rejects a wrong current password without changing anything', async () => {
  const { client, email } = await registerUser(base);
  const res = await change(client, 'not-my-password', 'brand-new-secret');
  assert.equal(res.status, 401);
  assert.match(res.body.error, /Current password is incorrect/);

  // The original password still works.
  const still = await login(base, email);
  assert.equal((await still.get('/api/auth/me')).status, 200);
});

test('a stolen session cannot lock the owner out', async () => {
  // The attacker holds a valid session but not the password.
  const { client, email } = await registerUser(base);
  const attacker = await login(base, email);
  const res = await change(attacker, 'guessing', 'attacker-password');
  assert.equal(res.status, 401);
  const owner = await login(base, email);
  assert.equal((await owner.get('/api/auth/me')).status, 200);
});

test('enforces the minimum length', async () => {
  const { client } = await registerUser(base);
  const res = await change(client, 'supersecret', 'short');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least 8 characters/);
});

test('refuses a new password identical to the current one', async () => {
  const { client } = await registerUser(base);
  const res = await change(client, 'supersecret', 'supersecret');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /different from the current one/);
});

test('requires both fields', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.put('/api/auth/password', { new_password: 'brand-new-secret' })).status, 400);
  assert.equal((await client.put('/api/auth/password', { current_password: 'supersecret' })).status, 400);
});

test('requires a session', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/auth/logout', {});
  assert.equal((await change(client, 'supersecret', 'brand-new-secret')).status, 401);
});

test('one user\'s change does not touch another user', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  assert.equal((await change(a.client, 'supersecret', 'brand-new-secret')).status, 200);
  assert.equal((await b.client.get('/api/auth/me')).status, 200, "the other user's session survives");
  const bStill = await login(base, b.email);
  assert.equal((await bStill.get('/api/auth/me')).status, 200, 'their password is unchanged');
});
