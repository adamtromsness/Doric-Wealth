import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/http.js';
import { startServer, stopServer, registerUser } from './helpers.js';
import { ask, askVision, resolveAiCreds, AiNotConfiguredError } from '../src/ai/claude.js';
import { pool, requestStore } from '../src/db.js';
import { config } from '../src/config.js';

// The repo .env sets a placeholder ANTHROPIC_API_KEY, so env fallback is always
// "configured". To exercise the not-configured paths we temporarily blank the
// env key on the live config object and restore it after.
async function withNoEnvKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = config.anthropicApiKey;
  config.anthropicApiKey = '';
  try { return await fn(); } finally { config.anthropicApiKey = saved; }
}

// ai/claude talks to api.anthropic.com via globalThis.fetch. We stub that host
// and pass everything else through. resolveAiCreds reads the per-user key on the
// request-scoped connection, so we drive these under withTenant(userId, bookId),
// which binds a pooled client with the tenant GUCs set (mirrors tenantDb).
async function withTenant<T>(userId: number, bookId: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      `SELECT set_config('app.book_id', $1, false), set_config('app.user_id', $2, false)`,
      [String(bookId), String(userId)]
    );
    return await requestStore.run({ client }, fn);
  } finally {
    await client.query('RESET ALL').catch(() => {});
    client.release();
  }
}

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: any; headers: any }> = [];
let responder: (body: any) => Response;
function installStub() {
  calls = [];
  responder = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'answer' }] }), { status: 200 });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.includes('api.anthropic.com')) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
      return responder(calls[calls.length - 1].body);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

// Register a user, give them an AI key, and return { userId, bookId } to run under.
async function tenantWithKey(): Promise<{ userId: number; bookId: number }> {
  const { client, me, bookId } = await registerUser(base);
  await client.put('/api/auth/ai-settings', { api_key: 'sk-ant-unit-KEY9' });
  return { userId: me.user?.id ?? me.id ?? me.user_id, bookId };
}

test('resolveAiCreds returns the per-user key + model under a tenant', async () => {
  const { userId, bookId } = await tenantWithKey();
  const creds = await withTenant(userId, bookId, () => resolveAiCreds());
  assert.equal(creds.apiKey, 'sk-ant-unit-KEY9');
  assert.ok(creds.model);
});

test('resolveAiCreds falls back to env when there is no tenant context', async () => {
  // No tenant → the users query returns nothing → env value is used.
  const creds = await resolveAiCreds();
  assert.equal(creds.apiKey, config.anthropicApiKey);
  // And with the env key blanked, it resolves to empty (unconfigured).
  const blanked = await withNoEnvKey(() => resolveAiCreds());
  assert.equal(blanked.apiKey, '');
});

test('ask() posts the prompt + key and returns concatenated text blocks', async () => {
  installStub();
  responder = () => new Response(JSON.stringify({
    content: [
      { type: 'text', text: 'line one' },
      { type: 'thinking', text: 'ignored' },
      { type: 'text', text: 'line two' },
    ],
  }), { status: 200 });
  const { userId, bookId } = await tenantWithKey();
  const out = await withTenant(userId, bookId, () => ask('Sum 2+2', { system: 'be terse', maxTokens: 42 }));
  assert.equal(out, 'line one\nline two');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-unit-KEY9');
  assert.equal(calls[0].body.max_tokens, 42);
  assert.equal(calls[0].body.system, 'be terse');
  assert.equal(calls[0].body.messages[0].content, 'Sum 2+2');
});

test('ask() throws AiNotConfiguredError when no key is available', async () => {
  installStub();
  const { client, me, bookId } = await registerUser(base);
  const userId = me.user?.id ?? me.id ?? me.user_id;
  void client;
  await withNoEnvKey(() => assert.rejects(
    withTenant(userId, bookId, () => ask('hi')),
    (e: any) => e instanceof AiNotConfiguredError
  ));
  assert.equal(calls.length, 0, 'no network call when unconfigured');
});

test('Anthropic failures become clear messages, without the upstream body', async () => {
  const { userId, bookId } = await tenantWithKey();
  const cases: [number, number, RegExp][] = [
    [401, 502, /rejected the API key\. Check it in AI Settings/],
    [403, 502, /rejected the API key/],
    [429, 503, /rate-limiting requests\. Try again in a minute/],
    [529, 503, /temporarily unavailable/],
    [500, 503, /temporarily unavailable/],
    [404, 502, /failed \(status 404\)\. Check the model in AI Settings/],
    [400, 502, /failed \(status 400\)/],
    [418, 502, /^The AI request failed \(status 418\)\.$/],
  ];
  for (const [upstream, status, msg] of cases) {
    installStub();
    responder = () => new Response('secret-upstream-detail req_123', { status: upstream });
    await assert.rejects(
      withTenant(userId, bookId, () => ask('hi')),
      (e: any) => e instanceof HttpError && e.status === status && msg.test(e.message) && !e.message.includes('secret-upstream-detail'),
      `upstream ${upstream}`,
    );
  }
});

test('a timeout or an unreachable Anthropic gives a clear message', async () => {
  const { userId, bookId } = await tenantWithKey();
  globalThis.fetch = (async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }) as typeof fetch;
  await assert.rejects(withTenant(userId, bookId, () => ask('hi')),
    (e: any) => e instanceof HttpError && e.status === 504 && /timed out/.test(e.message));
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(withTenant(userId, bookId, () => askVision([{ data: 'x', mime: 'image/png' }], 'p')),
    (e: any) => e instanceof HttpError && e.status === 502 && /Couldn't reach Anthropic/.test(e.message));
});

test('askVision() sends an image block + prompt and returns text', async () => {
  installStub();
  const { userId, bookId } = await tenantWithKey();
  const out = await withTenant(userId, bookId, () =>
    askVision([{ data: 'aGVsbG8=', mime: 'image/png' }], 'Read this', { maxTokens: 100 })
  );
  assert.equal(out, 'answer');
  const content = calls[0].body.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, 'aGVsbG8=');
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, 'Read this');
  assert.equal(calls[0].body.max_tokens, 100);
});

test('askVision() sends a PDF as a document block', async () => {
  installStub();
  const { userId, bookId } = await tenantWithKey();
  await withTenant(userId, bookId, () =>
    askVision([{ data: 'JVBERi0=', mime: 'application/pdf' }], 'Extract')
  );
  const content = calls[0].body.messages[0].content;
  assert.equal(content[0].type, 'document');
  assert.equal(content[0].source.media_type, 'application/pdf');
});

test('askVision() throws AiNotConfiguredError with no key, and on API errors', async () => {
  installStub();
  const { client, me, bookId } = await registerUser(base);
  const userId = me.user?.id ?? me.id ?? me.user_id;
  void client;
  await withNoEnvKey(() => assert.rejects(
    withTenant(userId, bookId, () => askVision([{ data: 'x', mime: 'image/png' }], 'p')),
    (e: any) => e instanceof AiNotConfiguredError
  ));

  const t = await tenantWithKey();
  responder = () => new Response('bad', { status: 400 });
  await assert.rejects(
    withTenant(t.userId, t.bookId, () => askVision([{ data: 'x', mime: 'image/png' }], 'p')),
    (e: any) => e instanceof HttpError && /status 400/.test(e.message)
  );
});
