import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, makeClient } from './helpers.js';
import { requireAuth, requireBook, hh, requireManager, membershipRole } from '../src/tenant.js';
import { HttpError } from '../src/http.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// ── Pure guard functions (no DB) ────────────────────────────────────────────
describe('requireAuth', () => {
  it('passes when req.user is set', () => {
    let err: any = 'unset';
    requireAuth({ user: { id: 1 } } as any, {} as any, (e?: any) => { err = e; });
    assert.equal(err, undefined);
  });
  it('errors 401 when req.user is missing', () => {
    let err: any;
    requireAuth({} as any, {} as any, (e?: any) => { err = e; });
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 401);
  });
});

describe('requireBook', () => {
  it('passes with user + book', () => {
    let err: any = 'unset';
    requireBook({ user: { id: 1 }, book: { id: 2 } } as any, {} as any, (e?: any) => { err = e; });
    assert.equal(err, undefined);
  });
  it('401 without a user', () => {
    let err: any;
    requireBook({} as any, {} as any, (e?: any) => { err = e; });
    assert.equal(err.status, 401);
  });
  it('403 with a user but no active book', () => {
    let err: any;
    requireBook({ user: { id: 1 } } as any, {} as any, (e?: any) => { err = e; });
    assert.equal(err.status, 403);
    assert.match(err.message, /No active book/);
  });
});

describe('hh', () => {
  it('returns the active book id', () => {
    assert.equal(hh({ book: { id: 99 } } as any), 99);
  });
  it('throws 403 when no active book', () => {
    try { hh({} as any); assert.fail('expected throw'); }
    catch (e) { assert.ok(e instanceof HttpError); assert.equal((e as HttpError).status, 403); }
  });
});

describe('requireManager (pure)', () => {
  it('allows owner and admin', () => {
    assert.doesNotThrow(() => requireManager({ book: { role: 'owner' } } as any));
    assert.doesNotThrow(() => requireManager({ book: { role: 'admin' } } as any));
  });
  it('throws 403 for a plain member or unknown role', () => {
    for (const role of ['member', undefined]) {
      try { requireManager({ book: { role } } as any); assert.fail('expected throw'); }
      catch (e) { assert.equal((e as HttpError).status, 403); }
    }
  });
});

// ── DB-backed: authContext / tenantDb / membershipRole via the server ────────
describe('authContext + tenantDb (via HTTP)', () => {
  it('an unauthenticated request is rejected by requireAuth', async () => {
    const anon = makeClient(base);
    const r = await anon.get('/api/accounts');
    assert.equal(r.status, 401);
  });

  it('an invalid/garbage session cookie is treated as anonymous', async () => {
    const anon = makeClient(base);
    anon.cookie = 'sid=not-a-real-token';
    const r = await anon.get('/api/accounts');
    assert.equal(r.status, 401);
  });

  it('a logged-in user with an active book can access tenant routes', async () => {
    const { client } = await registerUser(base);
    assert.equal((await client.get('/api/accounts')).status, 200);
  });

  it('cross-tenant reads 404 (RLS + WHERE book_id scope)', async () => {
    const a = await registerUser(base);
    const acct = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
    const b = await registerUser(base);
    assert.equal((await b.client.get(`/api/accounts/${acct}`)).status, 404);
  });
});

describe('membershipRole + book switching', () => {
  it('membershipRole returns the role for a member, null otherwise', async () => {
    const { bookId, me } = await registerUser(base);
    const userId = me.user.id;
    assert.equal(await membershipRole(userId, bookId), 'owner');
    // A non-existent book → null.
    assert.equal(await membershipRole(userId, 999_999), null);
  });

  it('switching to a book you do not belong to is 403', async () => {
    const a = await registerUser(base);
    const b = await registerUser(base);
    // b tries to switch into a's book.
    const r = await b.client.post('/api/books/switch', { book_id: a.bookId });
    assert.equal(r.status, 403);
  });

  it('switch requires a numeric book_id', async () => {
    const { client } = await registerUser(base);
    assert.equal((await client.post('/api/books/switch', {})).status, 400);
  });

  it('switching updates the active book (exercises the active_book_id resolution path)', async () => {
    const { client, bookId } = await registerUser(base);
    // Create a second book and confirm the switch resolves it as active.
    const created = await client.post('/api/books', { name: 'Second' });
    const secondId = created.body.activeBook.id;
    assert.notEqual(secondId, bookId);
    // Switch back to the first.
    const back = await client.post('/api/books/switch', { book_id: bookId });
    assert.equal(back.status, 200);
    assert.equal(back.body.activeBook.id, bookId);
  });

  it('a manager-only action (rename book) is allowed for the owner', async () => {
    const { client, bookId } = await registerUser(base);
    const r = await client.put(`/api/books/${bookId}`, { name: 'Renamed' });
    assert.equal(r.status, 200);
  });
});
