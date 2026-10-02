import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient, setExternalFetch } from './helpers.js';
import { config } from '../src/config.js';
import { runDuePropertyValuesSafe } from '../src/routes/properties.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });
afterEach(() => { setExternalFetch(null); config.rentcastApiKey = ''; });

// Fake RentCast: records each call's key + address and answers with `reply`.
let calls: { key: string | null; address: string | null }[] = [];
function stubRentcast(reply: () => Response = () => Response.json({ price: 412_345.4, priceRangeLow: 400_000, priceRangeHigh: 425_000 })) {
  calls = [];
  setExternalFetch((url, init) => {
    const u = new URL(url);
    assert.equal(u.hostname, 'api.rentcast.io');
    calls.push({ key: (init?.headers as any)?.['X-Api-Key'] ?? null, address: u.searchParams.get('address') });
    return reply();
  });
}

async function sql(text: string, params: any[] = []) {
  const db = testDbClient(); await db.connect();
  try { return (await db.query(text, params)).rows; } finally { await db.end(); }
}

const HOUSE = { name: 'Home', address: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701', property_type: 'single_family', square_feet: 1800 };

test('the book RentCast key: owners manage it, it is stored encrypted, members only see status', async () => {
  const owner = await registerUser(base);
  let s = (await owner.client.get('/api/integrations/rentcast')).body;
  assert.deepEqual(s, { configured: false, book_key_set: false, key_hint: null, server_fallback: false, can_manage: true });

  s = (await owner.client.put('/api/integrations/rentcast', { api_key: 'rc-live-SECRET9876' })).body;
  assert.equal(s.book_key_set, true);
  assert.equal(s.key_hint, '…9876');
  const stored = (await sql(`SELECT rentcast_api_key FROM books WHERE id = $1`, [owner.bookId]))[0].rentcast_api_key;
  assert.ok(stored.startsWith('enc1:') && !stored.includes('SECRET9876'), 'encrypted at rest');

  // A plain member of the book can see the status but not change the key.
  const code = (await owner.client.post(`/api/books/${owner.bookId}/invites`, {})).body.code;
  const member = await registerUser(base);
  await member.client.post(`/api/invites/${encodeURIComponent(code)}/accept`);
  const ms = (await member.client.get('/api/integrations/rentcast')).body;
  assert.equal(ms.book_key_set, true);
  assert.equal(ms.can_manage, false);
  assert.equal((await member.client.put('/api/integrations/rentcast', { api_key: 'x' })).status, 403);

  s = (await owner.client.put('/api/integrations/rentcast', { api_key: '' })).body;
  assert.equal(s.book_key_set, false);
  assert.equal((await sql(`SELECT rentcast_api_key FROM books WHERE id = $1`, [owner.bookId]))[0].rentcast_api_key, null);
});

test('estimates use the book key, fall back to the server key, and explain failures', async () => {
  const { client } = await registerUser(base);
  await client.put('/api/integrations/rentcast', { api_key: 'book-key-1' });
  stubRentcast();
  const est = await client.post('/api/properties/estimate-value', HOUSE);
  assert.equal(est.status, 200);
  assert.equal(est.body.value, 412_345);
  assert.equal(est.body.source, 'rentcast');
  assert.deepEqual(calls, [{ key: 'book-key-1', address: '12 Oak St Austin, TX 78701' }]);

  // No book key → the server's key.
  await client.put('/api/integrations/rentcast', { api_key: '' });
  config.rentcastApiKey = 'server-key';
  stubRentcast();
  await client.post('/api/properties/estimate-value', HOUSE);
  assert.equal(calls[0].key, 'server-key');
  assert.equal((await client.get('/api/integrations/rentcast')).body.server_fallback, true);

  for (const [status, re] of [[401, /rejected the API key/], [429, /request limit/], [404, /no value estimate/]] as const) {
    stubRentcast(() => Response.json({ message: 'upstream detail acct_42' }, { status }));
    const r = await client.post('/api/properties/estimate-value', HOUSE);
    assert.match(r.body.error, re);
    assert.ok(!JSON.stringify(r.body).includes('acct_42'), 'upstream message not leaked');
  }
});

test('turning on automatic updates needs an address and a key', async () => {
  const { client } = await registerUser(base);
  const noAddr = (await client.post('/api/properties', { name: 'Lot' })).body.id;
  const house = (await client.post('/api/properties', HOUSE)).body.id;

  const a = await client.put(`/api/properties/${noAddr}/auto-value`, { enabled: true });
  assert.equal(a.status, 400);
  assert.match(a.body.error, /street address/);
  const k = await client.put(`/api/properties/${house}/auto-value`, { enabled: true });
  assert.equal(k.status, 400);
  assert.match(k.body.error, /RentCast API key/);

  await client.put('/api/integrations/rentcast', { api_key: 'k' });
  const ok = await client.put(`/api/properties/${house}/auto-value`, { enabled: true, frequency: 'weekly' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.auto_value_enabled, true);
  assert.equal(ok.body.auto_value_frequency, 'weekly');
  assert.equal((await client.put(`/api/properties/${house}/auto-value`, { enabled: true, frequency: 'daily' })).status, 400);
  // Turning it off needs nothing.
  assert.equal((await client.put(`/api/properties/${noAddr}/auto-value`, { enabled: false })).status, 200);
});

test('the scheduled update records a RentCast snapshot, then waits until the property is due', async () => {
  const { client, bookId } = await registerUser(base);
  await client.put('/api/integrations/rentcast', { api_key: 'sched-key' });
  const house = (await client.post('/api/properties', HOUSE)).body.id;
  const off = (await client.post('/api/properties', { ...HOUSE, name: 'Not Automatic' })).body.id;
  await client.put(`/api/properties/${house}/auto-value`, { enabled: true });
  void off;

  stubRentcast();
  await runDuePropertyValuesSafe();
  const mine = calls.filter((c) => c.key === 'sched-key');
  assert.equal(mine.length, 1, 'only the enabled property is fetched');
  const values = (await client.get(`/api/properties/${house}/values`)).body;
  assert.equal(values.length, 1);
  assert.equal(Number(values[0].value), 412_345);
  assert.equal(values[0].source, 'rentcast');
  const p = (await sql(`SELECT current_value, auto_value_last_success_at, auto_value_last_error FROM properties WHERE id = $1`, [house]))[0];
  assert.equal(Number(p.current_value), 412_345, 'current value follows the latest snapshot');
  assert.ok(p.auto_value_last_success_at);
  assert.equal(p.auto_value_last_error, null);

  // Not due again this month.
  stubRentcast();
  await runDuePropertyValuesSafe();
  assert.equal(calls.filter((c) => c.key === 'sched-key').length, 0);

  // A month later it's due again.
  await sql(`UPDATE properties SET auto_value_last_success_at = now() - interval '32 days', auto_value_last_attempt_at = now() - interval '32 days' WHERE id = $1 AND book_id = $2`, [house, bookId]);
  stubRentcast();
  await runDuePropertyValuesSafe();
  assert.equal(calls.filter((c) => c.key === 'sched-key').length, 1);
});

test('a failed scheduled update is recorded on the property and retried at most daily', async () => {
  const { client, bookId } = await registerUser(base);
  await client.put('/api/integrations/rentcast', { api_key: 'bad-key' });
  const house = (await client.post('/api/properties', HOUSE)).body.id;
  await client.put(`/api/properties/${house}/auto-value`, { enabled: true });

  stubRentcast(() => Response.json({ message: 'inactive' }, { status: 401 }));
  await runDuePropertyValuesSafe();
  let p = (await sql(`SELECT auto_value_last_error, auto_value_last_success_at FROM properties WHERE id = $1`, [house]))[0];
  assert.match(p.auto_value_last_error, /rejected the API key/);
  assert.equal(p.auto_value_last_success_at, null);
  assert.equal((await client.get(`/api/properties/${house}/values`)).body.length, 0);

  // Not retried the same day.
  stubRentcast();
  await runDuePropertyValuesSafe();
  assert.equal(calls.filter((c) => c.key === 'bad-key').length, 0);

  // Next day, with a working key, it succeeds and clears the error.
  await client.put('/api/integrations/rentcast', { api_key: 'good-key' });
  await sql(`UPDATE properties SET auto_value_last_attempt_at = now() - interval '1 day' WHERE id = $1 AND book_id = $2`, [house, bookId]);
  stubRentcast();
  await runDuePropertyValuesSafe();
  p = (await sql(`SELECT auto_value_last_error, auto_value_last_success_at FROM properties WHERE id = $1`, [house]))[0];
  assert.equal(p.auto_value_last_error, null);
  assert.ok(p.auto_value_last_success_at);
});
