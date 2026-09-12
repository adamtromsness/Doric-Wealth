// This file's server boots WITH an API token so we can test enforcement; it must
// be set before the app is imported (startServer does the import).
process.env.API_TOKEN = 'test-secret-token';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, makeClient } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('API_TOKEN: health open, protected routes require a valid token', async () => {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  // No token / wrong token are rejected before any auth work.
  const noTok = await fetch(`${base}/api/accounts`);
  assert.equal(noTok.status, 401);
  assert.match((await noTok.json()).error, /API token/);
  const badTok = await fetch(`${base}/api/accounts`, { headers: { 'x-api-token': 'wrong' } });
  assert.equal(badTok.status, 401);
});

test('sessions: register -> me -> logout invalidates the session', async () => {
  const { client, email } = await registerUser(base); // client carries the API token
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, email);
  assert.equal((await client.post('/api/auth/logout')).status, 204);
  assert.equal((await client.get('/api/auth/me')).status, 401);
});

test('book switching changes the active book', async () => {
  const { client, bookId: first } = await registerUser(base);
  const created = await client.post('/api/books', { name: 'Second' });
  assert.equal(created.status, 201);
  const second = created.body.activeBook.id;
  assert.notEqual(second, first);
  const back = await client.post('/api/books/switch', { book_id: first });
  assert.equal(back.status, 200);
  assert.equal(back.body.activeBook.id, first);
});

test('invite accept: an invitee joins the inviter\'s book', async () => {
  const owner = await registerUser(base);
  const inv = await owner.client.post(`/api/books/${owner.bookId}/invites`, {});
  assert.equal(inv.status, 201);
  const code = inv.body.code;

  const invitee = await registerUser(base);
  const before = (await invitee.client.get('/api/auth/me')).body.books.length;
  const accept = await invitee.client.post(`/api/invites/${encodeURIComponent(code)}/accept`);
  assert.equal(accept.status, 200);
  const books = (await invitee.client.get('/api/auth/me')).body.books;
  assert.equal(books.length, before + 1);
  assert.ok(books.some((h: any) => h.id === owner.bookId), 'invitee is now a member of the owner book');
});

test('cross-book isolation: another book cannot read your account', async () => {
  const a = await registerUser(base);
  const acct = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const b = await registerUser(base);
  const list = (await b.client.get('/api/accounts')).body;
  assert.ok(!list.some((x: any) => x.id === acct), 'B does not see A\'s account');
});
