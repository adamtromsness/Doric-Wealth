import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';
import { assertUploadSize, MAX_UPLOAD_BYTES } from '../src/uploads.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('assertUploadSize caps file size and ignores absent/small values', () => {
  // Absent / blank / small are fine.
  assert.doesNotThrow(() => assertUploadSize(null));
  assert.doesNotThrow(() => assertUploadSize(''));
  assert.doesNotThrow(() => assertUploadSize('aGVsbG8='));
  // Over an explicit small cap throws a 413-style "too large" error (cheap boundary check).
  assert.throws(() => assertUploadSize('A'.repeat(200), 50), /too large/);
  // Just under the explicit cap is allowed.
  assert.doesNotThrow(() => assertUploadSize('A'.repeat(40), 50)); // 40 chars ≈ 30 bytes < 50
  // The default cap is a sane, non-trivial size.
  assert.ok(MAX_UPLOAD_BYTES >= 5 * 1024 * 1024);
});

test('receipt upload: MIME validation + safe inline serving', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const txn = (await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense' })).body.id;

  // Disallowed (script-capable) types are rejected before storage.
  assert.equal((await client.put(`/api/transactions/${txn}/receipt`, { image: 'aGVsbG8=', image_mime: 'text/html', items: [] })).status, 400);
  assert.equal((await client.put(`/api/transactions/${txn}/receipt`, { image: 'aGVsbG8=', image_mime: 'image/svg+xml', items: [] })).status, 400);
  // An allowed image type is stored.
  assert.equal((await client.put(`/api/transactions/${txn}/receipt`, { image: 'aGVsbG8=', image_mime: 'image/png', items: [] })).status, 200);

  // Served back with hardened headers.
  const res = await fetch(`${base}/api/transactions/${txn}/receipt/image`, { headers: { cookie: client.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition') || '', /inline/);
});

test('utility invoice file: MIME validation', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/utilities/invoices', { file: 'aGVsbG8=', file_mime: 'text/html', lines: [{ amount: 5 }] })).status, 400);
  assert.equal((await client.post('/api/utilities/invoices', { file: 'aGVsbG8=', file_mime: 'application/pdf', lines: [{ amount: 5 }] })).status, 201);
});
