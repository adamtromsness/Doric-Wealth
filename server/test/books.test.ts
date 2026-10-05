import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';

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

  // An unknown/blank role falls back to 'member'; a blank max_uses gets the safe
  // defaults: single use, expiring in 7 days.
  const memberInvite = await owner.client.post(`/api/books/${owner.bookId}/invites`, {
    role: 'superuser', max_uses: '',
  });
  assert.equal(memberInvite.status, 201);
  assert.equal(memberInvite.body.role, 'member');
  assert.equal(memberInvite.body.max_uses, 1);
  const days = (new Date(memberInvite.body.expires_at).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, `expires in ~7 days (got ${days})`);
  // Invalid explicit limits are refused.
  assert.equal((await owner.client.post(`/api/books/${owner.bookId}/invites`, { max_uses: 0 })).status, 400);
  assert.equal((await owner.client.post(`/api/books/${owner.bookId}/invites`, { expires_at: '2000-01-01' })).status, 400);

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

// Join `owner`'s book as a new user with the given role (via an invite).
async function joinAs(owner: any, role: 'member' | 'admin') {
  const code = (await owner.client.post(`/api/books/${owner.bookId}/invites`, { role })).body.code;
  const u = await registerUser(base);
  assert.equal((await u.client.post(`/api/invites/${encodeURIComponent(code)}/accept`)).status, 200);
  return u;
}

test('owners/admins can remove members; access ends on the next request', async () => {
  const owner = await registerUser(base, { book_name: 'Shared' });
  const member = await joinAs(owner, 'member');
  const admin = await joinAs(owner, 'admin');
  // The member is in the shared book (their active book after accepting).
  assert.equal((await member.client.get('/api/auth/me')).body.activeBook.id, owner.bookId);
  await owner.client.post('/api/accounts', { name: 'Shared Checking', type: 'checking' });
  assert.ok((await member.client.get('/api/accounts')).body.some((a: any) => a.name === 'Shared Checking'));

  // A plain member can't remove anyone else.
  assert.equal((await member.client.del(`/api/books/${owner.bookId}/members/${admin.me.user.id}`)).status, 403);
  // An admin can't remove the owner.
  assert.equal((await admin.client.del(`/api/books/${owner.bookId}/members/${owner.me.user.id}`)).status, 403);

  // The owner removes the member: their very next request no longer sees the shared book.
  assert.equal((await owner.client.del(`/api/books/${owner.bookId}/members/${member.me.user.id}`)).status, 200);
  const me = (await member.client.get('/api/auth/me')).body;
  assert.ok(!me.books.some((b: any) => b.id === owner.bookId));
  assert.notEqual(me.activeBook.id, owner.bookId, 'falls back to their own book');
  assert.ok(!(await member.client.get('/api/accounts')).body.some((a: any) => a.name === 'Shared Checking'));
  assert.equal((await owner.client.get(`/api/books/${owner.bookId}/members`)).body.length, 2);
  assert.equal((await owner.client.del(`/api/books/${owner.bookId}/members/${member.me.user.id}`)).status, 404, 'already removed');
});

test('anyone can leave a book, but the last owner can neither leave nor be removed', async () => {
  const owner = await registerUser(base, { book_name: 'Shared' });
  const member = await joinAs(owner, 'member');
  assert.equal((await member.client.del(`/api/books/${owner.bookId}/members/${member.me.user.id}`)).status, 200, 'member leaves');

  const lastOwnerLeaves = await owner.client.del(`/api/books/${owner.bookId}/members/${owner.me.user.id}`);
  assert.equal(lastOwnerLeaves.status, 409);
  assert.match(lastOwnerLeaves.body.error, /only owner/);

  // Promote a second owner directly, then either owner may go (but not both).
  const second = await joinAs(owner, 'admin');
  const db = testDbClient(); await db.connect();
  try { await db.query(`UPDATE memberships SET role = 'owner' WHERE user_id = $1 AND book_id = $2`, [second.me.user.id, owner.bookId]); }
  finally { await db.end(); }
  assert.equal((await second.client.del(`/api/books/${owner.bookId}/members/${owner.me.user.id}`)).status, 200, 'an owner can remove another owner');
  assert.equal((await second.client.del(`/api/books/${owner.bookId}/members/${second.me.user.id}`)).status, 409, 'now the last owner');
  // A non-member gets 403.
  const stranger = await registerUser(base);
  assert.equal((await stranger.client.del(`/api/books/${owner.bookId}/members/${second.me.user.id}`)).status, 403);
});
