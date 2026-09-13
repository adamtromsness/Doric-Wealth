import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, login } from './helpers.js';
import { assertProductionConfig, DEV_SECRET_KEY, config } from '../src/config.js';
import { destroyOtherSessions, deleteExpiredSessions, hashToken } from '../src/auth.js';
import { securityHeaders } from '../src/securityHeaders.js';
import { query, one } from '../src/db.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// ── Security headers ───────────────────────────────────────────────────────
test('every response carries the security headers', async () => {
  const { client } = await registerUser(base);
  const res = await client.raw('GET', '/api/auth/me');
  assert.equal(res.status, 200);

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(\)/);
});

test('the content security policy locks down scripts, framing and origins', async () => {
  const { client } = await registerUser(base);
  const csp = (await client.raw('GET', '/api/auth/me')).headers.get('content-security-policy') ?? '';

  assert.match(csp, /default-src 'self'/);
  // Scripts may only come from this origin — no inline, no CDN.
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  // The UI styles inline and pulls Google Fonts; images include base64 receipts.
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
  assert.match(csp, /font-src [^;]*fonts\.gstatic\.com/);
  assert.match(csp, /img-src [^;]*data:/);
  assert.ok(!/script-src [^;]*unsafe-inline/.test(csp), 'inline scripts stay blocked');
});

test('headers are present on error responses too', async () => {
  const { client } = await registerUser(base);
  const res = await client.raw('GET', '/api/accounts/999999');
  assert.ok(res.status >= 400, 'a missing account is an error');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});

test('HSTS is withheld while the session cookie is not HTTPS-only', async () => {
  // The harness runs with COOKIE_SECURE=false, standing in for plain-HTTP dev.
  const { client } = await registerUser(base);
  const res = await client.raw('GET', '/api/auth/me');
  assert.equal(config.cookieSecure, false);
  assert.equal(res.headers.get('strict-transport-security'), null,
    'pinning HSTS from a non-TLS origin would lock the host out for a year');
});

test('HSTS is advertised once the session cookie is HTTPS-only', (t) => {
  const orig = config.cookieSecure;
  t.after(() => { (config as any).cookieSecure = orig; });
  (config as any).cookieSecure = true;

  // Drive the middleware directly: the harness always runs over plain HTTP.
  const set = new Map<string, string>();
  let nexted = false;
  securityHeaders(
    {} as any,
    { setHeader: (k: string, v: string) => set.set(k.toLowerCase(), v) } as any,
    () => { nexted = true; },
  );
  assert.equal(set.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.ok(nexted, 'the middleware passes the request along');
});

// ── Production config validation ───────────────────────────────────────────
test('production config validation is a no-op outside production', () => {
  assert.equal(process.env.NODE_ENV, undefined);
  assert.doesNotThrow(() => assertProductionConfig());
});

test('production refuses to start on a missing, default or weak secret key', (t) => {
  const origEnv = process.env.NODE_ENV;
  const origKey = config.secretKey;
  t.after(() => {
    if (origEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = origEnv;
    (config as any).secretKey = origKey;
  });
  process.env.NODE_ENV = 'production';

  (config as any).secretKey = '';
  assert.throws(() => assertProductionConfig(), /APP_SECRET_KEY is not set/);

  (config as any).secretKey = DEV_SECRET_KEY;
  assert.throws(() => assertProductionConfig(), /development default/);

  (config as any).secretKey = 'too-short';
  assert.throws(() => assertProductionConfig(), /shorter than 32 characters/);

  // A real 32+ character key passes.
  (config as any).secretKey = 'x'.repeat(32);
  assert.doesNotThrow(() => assertProductionConfig());
});

// ── Session lifecycle ──────────────────────────────────────────────────────
test('sign out everywhere ends other sessions and keeps the caller signed in', async () => {
  const { client, email } = await registerUser(base);
  const other = await login(base, email);
  const third = await login(base, email);

  // All three sessions work to begin with.
  for (const c of [client, other, third]) assert.equal((await c.get('/api/auth/me')).status, 200);

  const res = await client.post('/api/auth/logout-all', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ended, 2, 'the two other sessions were ended');

  // The caller keeps working; the others are evicted.
  assert.equal((await client.get('/api/auth/me')).status, 200);
  assert.equal((await other.get('/api/auth/me')).status, 401);
  assert.equal((await third.get('/api/auth/me')).status, 401);
});

test('sign out everywhere requires a session', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/auth/logout', {});
  assert.equal((await client.post('/api/auth/logout-all', {})).status, 401);
});

test('one user cannot end another user\'s sessions', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  await a.client.post('/api/auth/logout-all', {});
  assert.equal((await b.client.get('/api/auth/me')).status, 200, "the other user's session survives");
});

test('destroyOtherSessions with no token spared ends every session', async () => {
  const { client, email } = await registerUser(base);
  const second = await login(base, email);
  const userId = (await client.get('/api/auth/me')).body.user.id as number;

  const ended = await destroyOtherSessions(userId);
  assert.equal(ended, 2);
  assert.equal((await client.get('/api/auth/me')).status, 401);
  assert.equal((await second.get('/api/auth/me')).status, 401);
});

test('the sweep deletes expired sessions and spares live ones', async () => {
  const { client } = await registerUser(base);
  const userId = (await client.get('/api/auth/me')).body.user.id as number;

  // A session that lapsed yesterday, alongside the live one from registering.
  await one(
    `INSERT INTO sessions (user_id, token_hash, active_book_id, expires_at)
     VALUES ($1,$2,NULL, now() - interval '1 day') RETURNING id`,
    [userId, hashToken('stale-token')]
  );
  const before = await query<{ id: number }>(`SELECT id FROM sessions WHERE user_id = $1`, [userId]);
  assert.equal(before.length, 2);

  const deleted = await deleteExpiredSessions();
  assert.ok(deleted >= 1, 'the lapsed session was swept');

  const after = await query<{ id: number }>(`SELECT id FROM sessions WHERE user_id = $1`, [userId]);
  assert.equal(after.length, 1, 'the live session survives');
  assert.equal((await client.get('/api/auth/me')).status, 200);
});
