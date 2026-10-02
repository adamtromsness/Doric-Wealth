import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { encryptLegacyAiKeys } from '../src/ai/aiKeys.js';
import { encryptSecret } from '../src/secrets.js';

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

async function storedKey(userId: number): Promise<string | null> {
  const db = testDbClient(); await db.connect();
  try { return (await db.query(`SELECT ai_api_key FROM users WHERE id = $1`, [userId])).rows[0].ai_api_key; }
  finally { await db.end(); }
}
async function setStoredKey(userId: number, value: string): Promise<void> {
  const db = testDbClient(); await db.connect();
  try { await db.query(`UPDATE users SET ai_api_key = $2 WHERE id = $1`, [userId, value]); }
  finally { await db.end(); }
}

test('personal AI keys are encrypted at rest', async () => {
  const { client, me } = await registerUser(base);
  await client.put('/api/auth/ai-settings', { api_key: 'sk-ant-secret-WXYZ9876' });
  const stored = await storedKey(me.user.id);
  assert.ok(stored!.startsWith('enc1:'), 'stored with the encryption prefix');
  assert.ok(!stored!.includes('sk-ant-secret-WXYZ9876') && !stored!.includes('WXYZ9876'), 'no plaintext in the database');
  assert.equal((await client.get('/api/auth/ai-settings')).body.key_hint, '…9876', 'hint comes from the decrypted key');

  await client.put('/api/auth/ai-settings', { api_key: '' });
  assert.equal(await storedKey(me.user.id), null, 'clearing removes it');
});

test('a plaintext key from before encryption still works and is encrypted on boot', async () => {
  const { client, me } = await registerUser(base);
  await setStoredKey(me.user.id, 'sk-ant-legacy-LEGA1111');
  assert.equal((await client.get('/api/auth/ai-settings')).body.key_hint, '…1111');

  assert.ok((await encryptLegacyAiKeys()) >= 1);
  const stored = await storedKey(me.user.id);
  assert.ok(stored!.startsWith('enc1:') && !stored!.includes('LEGA1111'));
  assert.equal((await client.get('/api/auth/ai-settings')).body.key_hint, '…1111', 'still usable after encryption');
  assert.equal(await encryptLegacyAiKeys(), 0, 'idempotent');
});

test('a key that cannot be decrypted (different server secret) is treated as not set', async () => {
  const { client, me } = await registerUser(base);
  // Valid format, but not decryptable with this server's key.
  const parts = encryptSecret('sk-ant-other-OTHR2222').split(':');
  parts[2] = Buffer.from('tampered').toString('base64');
  await setStoredKey(me.user.id, 'enc1:' + parts.join(':'));
  const s = (await client.get('/api/auth/ai-settings')).body;
  assert.equal(s.user_key_set, false);
  assert.equal(s.key_hint, null);
  assert.equal(s.configured, s.env_fallback);
});
