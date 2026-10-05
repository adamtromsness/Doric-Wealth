import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { claimAccessUrl, fetchAccounts } from '../src/simplefin.js';
import { HttpError } from '../src/http.js';

// These are pure library functions that make outbound HTTP calls via globalThis.fetch.
// We stub fetch for the SimpleFIN hosts so NO real network call is ever made.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler: (url: string, init?: any) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: any, init?: any) => handler(String(input), init)) as typeof fetch;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// ── claimAccessUrl ──────────────────────────────────────────────────────────

test('claimAccessUrl decodes token, POSTs the claim URL, returns the access URL', async () => {
  let seen: { url: string; method?: string } | null = null;
  stubFetch((url, init) => {
    seen = { url, method: init?.method };
    return new Response('https://user:pass@bridge.simplefin.org/simplefin', { status: 200 });
  });
  const access = await claimAccessUrl(b64('https://beta-bridge.simplefin.org/simplefin/claim/DEMO'));
  assert.equal(access, 'https://user:pass@bridge.simplefin.org/simplefin');
  assert.equal(seen!.url, 'https://beta-bridge.simplefin.org/simplefin/claim/DEMO');
  assert.equal(seen!.method, 'POST');
});

test('claimAccessUrl rejects a non-https claim URL (SSRF/protocol guard)', async () => {
  stubFetch(() => { throw new Error('should not fetch'); });
  await assert.rejects(
    claimAccessUrl(b64('http://bridge.simplefin.org/claim')),
    (e: any) => e instanceof HttpError && e.status === 400 && /https/i.test(e.message)
  );
});

test('claimAccessUrl only contacts allow-listed SimpleFIN hosts (SSRF guard)', async () => {
  stubFetch(() => { throw new Error('should not fetch'); });
  for (const host of [
    'https://127.0.0.1/claim', 'https://localhost/claim', 'https://10.0.0.5/claim', 'https://192.168.1.1/claim',
    'https://169.254.1.1/claim', 'https://172.16.0.1/claim',
    // IPv6 loopback / unique-local / mapped forms, which a private-address block-list missed.
    'https://[::1]/claim', 'https://[fc00::1]/claim', 'https://[::ffff:127.0.0.1]/claim',
    // Any other public host, including look-alikes, and odd ports on a real host.
    'https://example.com/claim', 'https://bridge.simplefin.org.evil.example/claim', 'https://evil-bridge.simplefin.org/claim',
    'https://bridge.simplefin.org:8443/claim',
  ]) {
    await assert.rejects(
      claimAccessUrl(b64(host)),
      (e: any) => e instanceof HttpError && e.status === 400 && /known SimpleFIN server/.test(e.message),
      host,
    );
  }
});

test('SimpleFIN redirects are refused, not followed', async () => {
  let calls = 0;
  stubFetch((_url, init) => { calls++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }); });
  await assert.rejects(claimAccessUrl(b64('https://bridge.simplefin.org/claim')), (e: any) => e instanceof HttpError && e.status === 502 && /redirect/.test(e.message));
  await assert.rejects(fetchAccounts('https://u:p@bridge.simplefin.org/simplefin'), (e: any) => e instanceof HttpError && /redirect/.test(e.message));
  assert.equal(calls, 2, 'one request each, no follow-up');
});

test('the allow-list can be changed for another SimpleFIN provider', async () => {
  const { config } = await import('../src/config.js');
  const saved = config.simplefinHosts;
  config.simplefinHosts = ['sf.example.org'];
  try {
    stubFetch(() => new Response('https://u:p@sf.example.org/simplefin', { status: 200 }));
    assert.equal(await claimAccessUrl(b64('https://sf.example.org/claim')), 'https://u:p@sf.example.org/simplefin');
    await assert.rejects(claimAccessUrl(b64('https://bridge.simplefin.org/claim')), /known SimpleFIN server/);
  } finally {
    config.simplefinHosts = saved;
  }
});

test('claimAccessUrl rejects an unparseable decoded URL', async () => {
  stubFetch(() => { throw new Error('should not fetch'); });
  await assert.rejects(
    claimAccessUrl(b64('not a url at all')),
    (e: any) => e instanceof HttpError && e.status === 400
  );
});

test('claimAccessUrl maps a network failure to 502', async () => {
  stubFetch(() => { throw new TypeError('network down'); });
  await assert.rejects(
    claimAccessUrl(b64('https://bridge.simplefin.org/claim')),
    (e: any) => e instanceof HttpError && e.status === 502 && /set up/i.test(e.message)
  );
});

test('claimAccessUrl maps a non-ok claim response to 502', async () => {
  stubFetch(() => new Response('nope', { status: 403 }));
  await assert.rejects(
    claimAccessUrl(b64('https://bridge.simplefin.org/claim')),
    (e: any) => e instanceof HttpError && e.status === 502 && /403/.test(e.message)
  );
});

test('claimAccessUrl rejects a hostile access URL returned by the claim (re-validated)', async () => {
  stubFetch(() => new Response('http://127.0.0.1/evil', { status: 200 }));
  await assert.rejects(
    claimAccessUrl(b64('https://bridge.simplefin.org/claim')),
    (e: any) => e instanceof HttpError && e.status === 400
  );
});

// ── fetchAccounts ───────────────────────────────────────────────────────────

test('fetchAccounts builds the /accounts URL with basic-auth header and query params', async () => {
  let seen: { url: string; headers?: any } | null = null;
  stubFetch((url, init) => {
    seen = { url, headers: init?.headers };
    return new Response(JSON.stringify({
      accounts: [{ id: 'a1', name: 'Checking', balance: '100.00', transactions: [] }],
      errors: ['minor warning'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const out = await fetchAccounts('https://u:p@bridge.simplefin.org/simplefin/', { startDate: 1700000000, endDate: 1700100000, pending: true });
  assert.equal(out.accounts.length, 1);
  assert.equal(out.accounts[0].id, 'a1');
  assert.deepEqual(out.errors, ['minor warning']);

  // Trailing slash removed, /accounts appended, params set, pending=1.
  assert.ok(seen!.url.startsWith('https://bridge.simplefin.org/simplefin/accounts?'), seen!.url);
  const q = new URL(seen!.url).searchParams;
  assert.equal(q.get('start-date'), '1700000000');
  assert.equal(q.get('end-date'), '1700100000');
  assert.equal(q.get('pending'), '1');
  // Basic-auth extracted from userinfo into a header (undici won't send URL creds).
  assert.equal(seen!.headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  // The URL itself no longer carries the credentials.
  assert.ok(!seen!.url.includes('u:p@'));
});

test('fetchAccounts defaults pending to 0 and omits date params when not given', async () => {
  let seenUrl = '';
  stubFetch((url) => {
    seenUrl = url;
    return new Response(JSON.stringify({}), { status: 200 });
  });
  const out = await fetchAccounts('https://bridge.simplefin.org/simplefin');
  // Missing accounts/errors default to empty arrays.
  assert.deepEqual(out.accounts, []);
  assert.deepEqual(out.errors, []);
  const q = new URL(seenUrl).searchParams;
  assert.equal(q.get('pending'), '0');
  assert.equal(q.get('start-date'), null);
  assert.equal(q.get('end-date'), null);
});

test('fetchAccounts rejects an unsafe access URL before fetching', async () => {
  stubFetch(() => { throw new Error('should not fetch'); });
  await assert.rejects(
    fetchAccounts('https://127.0.0.1/simplefin'),
    (e: any) => e instanceof HttpError && e.status === 400
  );
});

test('fetchAccounts maps a network failure to 502', async () => {
  stubFetch(() => { throw new TypeError('boom'); });
  await assert.rejects(
    fetchAccounts('https://bridge.simplefin.org/simplefin'),
    (e: any) => e instanceof HttpError && e.status === 502 && /reach SimpleFIN/.test(e.message)
  );
});

test('fetchAccounts maps a non-ok response to 502', async () => {
  stubFetch(() => new Response('server error', { status: 500 }));
  await assert.rejects(
    fetchAccounts('https://bridge.simplefin.org/simplefin'),
    (e: any) => e instanceof HttpError && e.status === 502 && /500/.test(e.message)
  );
});
