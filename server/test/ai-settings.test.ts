import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('per-user AI key: set, masked status, model override, and clear', async () => {
  const { client } = await registerUser(base);

  // No personal key yet; AI is configured only if the server has an env key.
  let s = (await client.get('/api/auth/ai-settings')).body;
  assert.equal(s.user_key_set, false);
  assert.equal((await client.get('/api/analysis/status')).body.configured, s.env_fallback);

  // Set a key — enables AI; only a masked hint is returned, never the raw key.
  const resp = await client.put('/api/auth/ai-settings', { api_key: 'sk-ant-test-ABCD1234' });
  assert.equal(resp.status, 200);
  s = resp.body;
  assert.equal(s.user_key_set, true);
  assert.equal(s.configured, true);
  assert.equal(s.key_hint, '…1234');
  assert.ok(!JSON.stringify(s).includes('sk-ant-test-ABCD1234'), 'raw key must not be returned');

  // The analysis status endpoint now reports enabled for this user.
  assert.equal((await client.get('/api/analysis/status')).body.configured, true);

  // Setting just the model must not wipe the key.
  s = (await client.put('/api/auth/ai-settings', { model: 'claude-opus-4-8' })).body;
  assert.equal(s.user_key_set, true);
  assert.equal(s.model, 'claude-opus-4-8');

  // Clearing the key reverts to env (off here).
  s = (await client.put('/api/auth/ai-settings', { api_key: '' })).body;
  assert.equal(s.user_key_set, false);
  assert.equal(s.key_hint, null);
  assert.equal(s.configured, s.env_fallback);
});

test('AI keys are per-user and independent', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);

  await a.client.put('/api/auth/ai-settings', { api_key: 'sk-ant-user-AAAA1111' });
  // A is enabled; B is unaffected (only env fallback).
  assert.equal((await a.client.get('/api/auth/ai-settings')).body.user_key_set, true);
  const bs = (await b.client.get('/api/auth/ai-settings')).body;
  assert.equal(bs.user_key_set, false);
  assert.equal((await b.client.get('/api/analysis/status')).body.configured, bs.env_fallback);

  // Requires authentication.
  const anon = await fetch(`${base}/api/auth/ai-settings`);
  assert.equal(anon.status, 401);
});
