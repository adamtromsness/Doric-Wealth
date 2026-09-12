import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../src/secrets.js';
import { config } from '../src/config.js';

// secrets.ts derives its key from config.secretKey (a mutable exported object), so we
// set it directly here rather than juggling process.env before import.
describe('secrets: encryptSecret / decryptSecret', () => {
  let saved: string;
  beforeEach(() => {
    saved = config.secretKey;
    config.secretKey = 'test-secret-key';
  });
  afterEach(() => {
    config.secretKey = saved;
  });

  it('round-trips a plaintext value', () => {
    const plain = 'https://user:pass@bridge.simplefin.org/accounts';
    const blob = encryptSecret(plain);
    assert.equal(decryptSecret(blob), plain);
  });

  it('produces the iv:tag:ct base64 format', () => {
    const blob = encryptSecret('hello');
    const parts = blob.split(':');
    assert.equal(parts.length, 3);
    for (const p of parts) {
      assert.ok(p.length > 0);
      // valid base64 round-trips
      assert.equal(Buffer.from(p, 'base64').toString('base64').replace(/=+$/, ''), p.replace(/=+$/, ''));
    }
  });

  it('uses a random IV so the same plaintext encrypts differently each time', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), 'same');
    assert.equal(decryptSecret(b), 'same');
  });

  it('encrypting an empty string yields an empty-ciphertext segment (rejected on decrypt)', () => {
    // AES-GCM of '' produces zero ciphertext bytes, so the blob is `iv:tag:` — the
    // trailing empty segment is (correctly) treated as malformed on the way back.
    const blob = encryptSecret('');
    assert.match(blob, /:$/);
    assert.throws(() => decryptSecret(blob), /Malformed encrypted secret/);
  });

  it('round-trips unicode', () => {
    const s = 'café — 日本語 — 🔒';
    assert.equal(decryptSecret(encryptSecret(s)), s);
  });

  it('throws on a malformed blob (too few segments)', () => {
    assert.throws(() => decryptSecret('onlyonepart'), /Malformed encrypted secret/);
    assert.throws(() => decryptSecret('iv:tag'), /Malformed encrypted secret/);
    assert.throws(() => decryptSecret(''), /Malformed encrypted secret/);
  });

  it('throws when a segment is empty', () => {
    assert.throws(() => decryptSecret('::'), /Malformed encrypted secret/);
    assert.throws(() => decryptSecret('a::c'), /Malformed encrypted secret/);
  });

  it('throws (auth tag verification) on tampered ciphertext', () => {
    const blob = encryptSecret('secret-value');
    const [iv, tag, ct] = blob.split(':');
    // Flip the ciphertext to a different valid-base64 value.
    const tampered = Buffer.from(ct, 'base64');
    tampered[0] ^= 0xff;
    const bad = [iv, tag, tampered.toString('base64')].join(':');
    assert.throws(() => decryptSecret(bad));
  });

  it('throws (auth tag verification) on a tampered auth tag', () => {
    const blob = encryptSecret('secret-value');
    const [iv, tag, ct] = blob.split(':');
    const t = Buffer.from(tag, 'base64');
    t[0] ^= 0xff;
    assert.throws(() => decryptSecret([iv, t.toString('base64'), ct].join(':')));
  });

  it('fails to decrypt with a different key', () => {
    const blob = encryptSecret('secret');
    config.secretKey = 'a-completely-different-key';
    assert.throws(() => decryptSecret(blob));
  });

  it('throws a clear error when secretKey is unset (encrypt)', () => {
    config.secretKey = '';
    assert.throws(() => encryptSecret('x'), /APP_SECRET_KEY is not set/);
  });

  it('throws a clear error when secretKey is unset (decrypt)', () => {
    // Build a blob with a key set, then clear the key and attempt to decrypt.
    const blob = encryptSecret('x');
    config.secretKey = '';
    assert.throws(() => decryptSecret(blob), /APP_SECRET_KEY is not set/);
  });
});
