import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, makeClient, testDbClient } from './helpers.js';

let base: string;
let db: ReturnType<typeof testDbClient>;
before(async () => { base = await startServer(); db = testDbClient(); await db.connect(); });
after(async () => { await db.end(); await stopServer(); });

async function makeInvite(owner: any, body: Record<string, unknown> = {}) {
  const r = await owner.client.post(`/api/books/${owner.bookId}/invites`, body);
  assert.equal(r.status, 201);
  return r.body; // { id, code, ... }
}

test('GET /invites/:code previews a usable invite (book name + role)', async () => {
  const owner = await registerUser(base, { book_name: 'Shared Ledger' });
  const inv = await makeInvite(owner, { role: 'admin' });
  // Public preview: no auth required.
  const anon = makeClient(base);
  const preview = await anon.get(`/api/invites/${encodeURIComponent(inv.code)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.book_name, 'Shared Ledger');
  assert.equal(preview.body.role, 'admin');
  // Nothing else leaks.
  assert.deepEqual(Object.keys(preview.body).sort(), ['book_name', 'role']);
});

test('GET /invites/:code returns 404 for unknown / revoked / expired / maxed codes', async () => {
  const owner = await registerUser(base);
  const anon = makeClient(base);

  // Unknown code.
  assert.equal((await anon.get('/api/invites/does-not-exist')).status, 404);

  // Revoked.
  const revoked = await makeInvite(owner);
  await db.query(`UPDATE invites SET revoked = true WHERE id = $1`, [revoked.id]);
  assert.equal((await anon.get(`/api/invites/${encodeURIComponent(revoked.code)}`)).status, 404);

  // Expired.
  const expired = await makeInvite(owner);
  await db.query(`UPDATE invites SET expires_at = now() - interval '1 hour' WHERE id = $1`, [expired.id]);
  assert.equal((await anon.get(`/api/invites/${encodeURIComponent(expired.code)}`)).status, 404);

  // Maxed out (uses >= max_uses).
  const maxed = await makeInvite(owner, { max_uses: 1 });
  await db.query(`UPDATE invites SET uses = 1 WHERE id = $1`, [maxed.id]);
  const r = await anon.get(`/api/invites/${encodeURIComponent(maxed.code)}`);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /invalid or has expired/i);
});

test('POST /invites/:code/accept requires auth', async () => {
  const owner = await registerUser(base);
  const inv = await makeInvite(owner);
  const anon = makeClient(base);
  assert.equal((await anon.post(`/api/invites/${encodeURIComponent(inv.code)}/accept`)).status, 401);
});

test('accept joins the book, bumps uses, and is idempotent for an existing member', async () => {
  const owner = await registerUser(base);
  const inv = await makeInvite(owner, { role: 'member', max_uses: 5 });

  const joiner = await registerUser(base);
  const before = (await joiner.client.get('/api/auth/me')).body.books.length;

  const accept = await joiner.client.post(`/api/invites/${encodeURIComponent(inv.code)}/accept`);
  assert.equal(accept.status, 200);
  assert.equal(accept.body.activeBook.id, owner.bookId, 'joined book becomes active');
  const afterBooks = (await joiner.client.get('/api/auth/me')).body.books;
  assert.equal(afterBooks.length, before + 1);

  const uses1 = (await db.query(`SELECT uses FROM invites WHERE id = $1`, [inv.id])).rows[0].uses;
  assert.equal(uses1, 1, 'accept bumped uses');

  // Accepting again as the same (already-a-member) user is a no-op: no duplicate
  // membership, uses NOT bumped again.
  const again = await joiner.client.post(`/api/invites/${encodeURIComponent(inv.code)}/accept`);
  assert.equal(again.status, 200);
  const memberships = (await db.query(
    `SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND book_id = $2`,
    [joiner.me.user.id, owner.bookId]
  )).rows[0].n;
  assert.equal(memberships, 1, 'no duplicate membership');
  const uses2 = (await db.query(`SELECT uses FROM invites WHERE id = $1`, [inv.id])).rows[0].uses;
  assert.equal(uses2, 1, 'uses unchanged for an already-member accept');
});

test('accept rejects revoked / expired / maxed invites with 404', async () => {
  const owner = await registerUser(base);

  const revoked = await makeInvite(owner);
  await db.query(`UPDATE invites SET revoked = true WHERE id = $1`, [revoked.id]);
  const j1 = await registerUser(base);
  assert.equal((await j1.client.post(`/api/invites/${encodeURIComponent(revoked.code)}/accept`)).status, 404);

  const expired = await makeInvite(owner);
  await db.query(`UPDATE invites SET expires_at = now() - interval '1 hour' WHERE id = $1`, [expired.id]);
  const j2 = await registerUser(base);
  assert.equal((await j2.client.post(`/api/invites/${encodeURIComponent(expired.code)}/accept`)).status, 404);

  const maxed = await makeInvite(owner, { max_uses: 1 });
  await db.query(`UPDATE invites SET uses = 1 WHERE id = $1`, [maxed.id]);
  const j3 = await registerUser(base);
  const r = await j3.client.post(`/api/invites/${encodeURIComponent(maxed.code)}/accept`);
  assert.equal(r.status, 404);
});
