import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('GET /books lists the caller\'s books with roles', async () => {
  const { client, bookId } = await registerUser(base);
  const list = (await client.get('/api/books')).body;
  assert.ok(Array.isArray(list));
  const own = list.find((h: any) => h.id === bookId);
  assert.ok(own, 'the owned book is listed');
  assert.equal(own.role, 'owner');
});

test('POST /books validates the name and creates+activates a book', async () => {
  const { client } = await registerUser(base);
  // Missing name → 400 (require_).
  assert.equal((await client.post('/api/books', {})).status, 400);
  // Blank/whitespace name → 400.
  const blank = await client.post('/api/books', { name: '   ' });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /name is required/i);

  const created = await client.post('/api/books', { name: '  My Second Book ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.activeBook.name, 'My Second Book', 'name is trimmed');
  assert.equal(created.body.activeBook.role, 'owner');
});

test('POST /books/switch validates membership', async () => {
  const { client, bookId } = await registerUser(base);
  // Non-numeric book_id → 400.
  const bad = await client.post('/api/books/switch', { book_id: 'nope' });
  assert.equal(bad.status, 400);
  // A book the caller is not a member of → 403.
  const other = await registerUser(base);
  const notMember = await client.post('/api/books/switch', { book_id: other.bookId });
  assert.equal(notMember.status, 403);
  assert.match(notMember.body.error, /not a member/i);
  // Switching to a real membership works.
  const ok = await client.post('/api/books/switch', { book_id: bookId });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.activeBook.id, bookId);
});

test('PUT /books/:id renames (owner/admin) and validates the name', async () => {
  const { client, bookId } = await registerUser(base);
  // Blank name → 400.
  const blank = await client.put(`/api/books/${bookId}`, { name: '  ' });
  assert.equal(blank.status, 400);
  // Missing name → 400.
  assert.equal((await client.put(`/api/books/${bookId}`, {})).status, 400);

  const ok = await client.put(`/api/books/${bookId}`, { name: 'Renamed Book' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.books.some((h: any) => h.id === bookId && h.name === 'Renamed Book'));
});

test('PUT /books/:id rejects non-members and plain members', async () => {
  const owner = await registerUser(base);
  // Non-member cannot rename → 403 "not a member".
  const stranger = await registerUser(base);
  const notMember = await stranger.client.put(`/api/books/${owner.bookId}`, { name: 'Hijack' });
  assert.equal(notMember.status, 403);
  assert.match(notMember.body.error, /not a member/i);

  // A plain member (joined via invite) cannot rename → 403 "owner or admin".
  const inv = (await owner.client.post(`/api/books/${owner.bookId}/invites`, { role: 'member' })).body;
  const member = await registerUser(base);
  await member.client.post(`/api/invites/${encodeURIComponent(inv.code)}/accept`);
  const memberRename = await member.client.put(`/api/books/${owner.bookId}`, { name: 'Nope' });
  assert.equal(memberRename.status, 403);
  assert.match(memberRename.body.error, /owner or admin/i);
});

test('GET /books/:id/members lists members and is member-scoped', async () => {
  const owner = await registerUser(base);
  const members = await owner.client.get(`/api/books/${owner.bookId}/members`);
  assert.equal(members.status, 200);
  assert.ok(members.body.some((m: any) => m.email === owner.email && m.role === 'owner'));

  // A non-member gets 403.
  const stranger = await registerUser(base);
  const denied = await stranger.client.get(`/api/books/${owner.bookId}/members`);
  assert.equal(denied.status, 403);
});

test('book invites: create (role/expiry/max_uses), list, and revoke', async () => {
  const owner = await registerUser(base);

  // Non-manager cannot create an invite.
  const stranger = await registerUser(base);
  assert.equal((await stranger.client.post(`/api/books/${owner.bookId}/invites`, {})).status, 403);

  // Create an admin invite with an expiry + max_uses.
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const created = await owner.client.post(`/api/books/${owner.bookId}/invites`, {
    role: 'admin', expires_at: future, max_uses: 5,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'admin');
  assert.equal(created.body.max_uses, 5);
  assert.ok(created.body.url.includes(created.body.code), 'the invite url embeds the code');

  // An unknown/blank role falls back to 'member'; empty-string max_uses → null.
  const memberInvite = await owner.client.post(`/api/books/${owner.bookId}/invites`, {
    role: 'superuser', max_uses: '',
  });
  assert.equal(memberInvite.status, 201);
  assert.equal(memberInvite.body.role, 'member');
  assert.equal(memberInvite.body.max_uses, null);

  // The list shows active invites (owner/admin only).
  const list = await owner.client.get(`/api/books/${owner.bookId}/invites`);
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 2);
  assert.ok(list.body.every((r: any) => typeof r.url === 'string'));
  // Non-manager cannot list.
  assert.equal((await stranger.client.get(`/api/books/${owner.bookId}/invites`)).status, 403);

  // Revoke one invite → it drops out of the active list.
  const toRevoke = created.body.id;
  const del = await owner.client.del(`/api/books/${owner.bookId}/invites/${toRevoke}`);
  assert.equal(del.status, 204);
  const after = (await owner.client.get(`/api/books/${owner.bookId}/invites`)).body;
  assert.ok(!after.some((r: any) => r.id === toRevoke), 'revoked invite is gone from the active list');
  // Non-manager cannot revoke.
  assert.equal((await stranger.client.del(`/api/books/${owner.bookId}/invites/${memberInvite.body.id}`)).status, 403);
});
