import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';
import { config } from '../src/config.js';

// The analysis routes call ai/claude.ask(), which POSTs to api.anthropic.com via
// globalThis.fetch. Tests run in-process, so the same globalThis.fetch is used
// both by our HTTP client (to reach the local server) and by ask() (to reach
// Anthropic). We install a stub that: (a) answers Anthropic with canned JSON,
// (b) passes everything else through to the real fetch. Restored after each test.

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const realFetch = globalThis.fetch;
let anthropicCalls: Array<{ body: any; headers: any }> = [];
// Configurable per test.
let anthropicResponder: (body: any) => Response = () =>
  new Response(JSON.stringify({ content: [{ type: 'text', text: 'AI ANALYSIS RESULT' }] }), { status: 200 });

beforeEach(() => {
  anthropicCalls = [];
  anthropicResponder = () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text: 'AI ANALYSIS RESULT' }] }), { status: 200 });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.includes('api.anthropic.com')) {
      const body = init?.body ? JSON.parse(init.body) : null;
      anthropicCalls.push({ body, headers: init?.headers });
      return anthropicResponder(body);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

// Give the signed-in user an Anthropic key so resolveAiCreds() returns one.
async function enableAi(client: any) {
  const r = await client.put('/api/auth/ai-settings', { api_key: 'sk-ant-test-KEY0001' });
  assert.equal(r.status, 200);
}

// ── status ────────────────────────────────────────────────────────────────

test('GET /status reports configured + model', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  const r = await client.get('/api/analysis/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, true);
  assert.ok(r.body.model);
});

// ── list ────────────────────────────────────────────────────────────────

test('GET / lists saved analyses, optionally filtered by kind, scoped to the book', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  // Produce two analyses of different kinds.
  await client.post('/api/analysis/custom', { question: 'How am I doing?' });
  await client.post('/api/analysis/overview', {});

  const all = (await client.get('/api/analysis/')).body;
  assert.ok(all.length >= 2);
  const kinds = new Set(all.map((a: any) => a.kind));
  assert.ok(kinds.has('custom'));
  assert.ok(kinds.has('spending_overview'));

  const custom = (await client.get('/api/analysis/?kind=custom')).body;
  assert.ok(custom.length >= 1);
  assert.ok(custom.every((a: any) => a.kind === 'custom'));
});

test('saved analyses are tenant-scoped: another book cannot see them', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  await enableAi(a.client);
  await a.client.post('/api/analysis/custom', { question: 'private' });

  const bList = (await b.client.get('/api/analysis/')).body;
  assert.equal(bList.length, 0);
});

// ── custom ──────────────────────────────────────────────────────────────

test('POST /custom builds a snapshot prompt, calls Claude, saves + returns the result', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  // Seed a little data so the snapshot isn't empty.
  await client.post('/api/accounts', { name: 'Checking', type: 'checking' });

  const r = await client.post('/api/analysis/custom', { question: 'What is my net worth?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'AI ANALYSIS RESULT');
  // The Anthropic request carried our key and the question.
  assert.equal(anthropicCalls.length, 1);
  assert.equal(anthropicCalls[0].headers['x-api-key'], 'sk-ant-test-KEY0001');
  assert.match(anthropicCalls[0].body.messages[0].content, /What is my net worth\?/);

  // It was persisted with kind='custom' and the question as the title.
  const saved = (await client.get('/api/analysis/?kind=custom')).body;
  assert.ok(saved.some((a: any) => a.title === 'What is my net worth?' && a.result === 'AI ANALYSIS RESULT'));
});

test('POST /custom rejects a missing/empty/over-long question (validation)', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  assert.equal((await client.post('/api/analysis/custom', {})).status, 400);
  assert.equal((await client.post('/api/analysis/custom', { question: '' })).status, 400);
  assert.equal((await client.post('/api/analysis/custom', { question: 'x'.repeat(1001) })).status, 400);
  // No Anthropic call should have happened for rejected input.
  assert.equal(anthropicCalls.length, 0);
});

test('POST /custom returns 503 when AI is not configured', async () => {
  const { client } = await registerUser(base);
  // No personal key set; blank the env fallback so the book is truly unconfigured.
  const saved = config.anthropicApiKey;
  config.anthropicApiKey = '';
  try {
    const r = await client.post('/api/analysis/custom', { question: 'anything' });
    // The 503 status distinguishes the not-configured path (vs a 500 from a real
    // upstream error), and its message reaches the client so the user knows the fix.
    assert.equal(r.status, 503);
    assert.match(r.body.error, /AI is not configured/);
    assert.equal(anthropicCalls.length, 0);
  } finally {
    config.anthropicApiKey = saved;
  }
});

test('POST /custom surfaces a non-503 error when Anthropic returns an API error', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  anthropicResponder = () => new Response('rate limited', { status: 429 });
  const r = await client.post('/api/analysis/custom', { question: 'go' });
  assert.equal(r.status, 500);
  // A non-HttpError is still masked: the upstream response body must not leak.
  assert.equal(r.body.error, 'Internal error');
});

// ── overview ────────────────────────────────────────────────────────────

test('POST /overview computes net worth + category breakdown and analyzes it', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 5000 })).body.id;
  await client.post('/api/transactions', { amount: 4200, account_id: acct, direction: 'income', txn_date: '2026-08-01' });
  await client.post('/api/transactions', { amount: 1200, account_id: acct, direction: 'expense', txn_date: '2026-08-15' });

  const r = await client.post('/api/analysis/overview', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'AI ANALYSIS RESULT');
  assert.ok(typeof r.body.netWorth === 'number');
  assert.ok(Array.isArray(r.body.byCategory));
  assert.equal(anthropicCalls.length, 1);
  // The prompt embeds the computed net worth.
  assert.match(anthropicCalls[0].body.messages[0].content, /CURRENT NET WORTH/);
});

// ── products ────────────────────────────────────────────────────────────

test('POST /products 400s when there are no receipt items', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  const r = await client.post('/api/analysis/products', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error ?? JSON.stringify(r.body), /receipt items/i);
  assert.equal(anthropicCalls.length, 0);
});

test('POST /products analyzes itemized receipts when present', async () => {
  const { client, bookId } = await registerUser(base);
  await enableAi(client);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const txn = (await client.post('/api/transactions', { amount: 4500, account_id: acct, direction: 'expense', txn_date: '2026-07-01', merchant: 'Grocery' })).body;
  const txnId = txn.id ?? txn.posted?.[0]?.id ?? txn?.transaction?.id;

  // Insert a receipt + items directly (RLS-scoped).
  const { testDbClient } = await import('./helpers.js');
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const rec = (await db.query(
      `INSERT INTO receipts (transaction_id, merchant, book_id) VALUES ($1,'Grocery',$2) RETURNING id`,
      [txnId, bookId]
    )).rows[0];
    await db.query(
      `INSERT INTO receipt_items (receipt_id, name, product_category, quantity, unit_price, total_price)
       VALUES ($1,'Milk','dairy',2,3.50,7.00), ($1,'Bread','bakery',1,2.00,2.00)`,
      [rec.id]
    );
  } finally { await db.end(); }

  const r = await client.post('/api/analysis/products', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'AI ANALYSIS RESULT');
  assert.ok(Array.isArray(r.body.topProducts) && r.body.topProducts.length >= 1);
  assert.ok(Array.isArray(r.body.byCategory));
  assert.match(anthropicCalls[0].body.messages[0].content, /TOP PRODUCTS/);
});

// ── vehicle / property cost of ownership ──────────────────────────────────

test('POST /vehicle/:id/cost-of-ownership analyzes a vehicle', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Truck', make: 'Ford', model: 'F150', year: 2020, purchase_price: 30000, current_value: 20000 })).body;
  await client.post('/api/transactions', { amount: 15000, account_id: acct, direction: 'expense', txn_date: '2026-06-01', merchant: 'Shop', tags: [{ kind: 'vehicle', ref_id: veh.id }] });

  const r = await client.post(`/api/analysis/vehicle/${veh.id}/cost-of-ownership`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'AI ANALYSIS RESULT');
  assert.ok(r.body.summary);
  assert.match(anthropicCalls[0].body.messages[0].content, /cost of ownership/i);

  // Persisted with kind vehicle_tco.
  const saved = (await client.get('/api/analysis/?kind=vehicle_tco')).body;
  assert.ok(saved.length >= 1);
});

test('POST /property/:id/cost-of-ownership analyzes a property', async () => {
  const { client } = await registerUser(base);
  await enableAi(client);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const prop = (await client.post('/api/properties', {
    name: 'Rental A', property_type: 'single_family', purchase_price: 300000, current_value: 350000,
    mortgage_balance: 200000, rental_income: 2000, is_rental: true,
  })).body;
  await client.post('/api/transactions', { amount: 50000, account_id: acct, direction: 'expense', txn_date: '2026-05-01', merchant: 'Plumber', tags: [{ kind: 'property', ref_id: prop.id }] });
  await client.post('/api/transactions', { amount: 200000, account_id: acct, direction: 'income', txn_date: '2026-05-05', merchant: 'Tenant', tags: [{ kind: 'property', ref_id: prop.id }] });

  const r = await client.post(`/api/analysis/property/${prop.id}/cost-of-ownership`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'AI ANALYSIS RESULT');
  assert.ok(r.body.summary);
  assert.match(anthropicCalls[0].body.messages[0].content, /PROPERTY/);

  const saved = (await client.get('/api/analysis/?kind=property_cost')).body;
  assert.ok(saved.length >= 1);
});

test('analysis endpoints require authentication', async () => {
  const anon = await realFetch(`${base}/api/analysis/`);
  assert.equal(anon.status, 401);
});
