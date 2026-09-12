// Symmetric encryption for third-party credentials stored at rest (e.g. a linked
// SimpleFIN access URL, which embeds read-only bank-data basic-auth creds). Uses
// AES-256-GCM (authenticated) with a key derived from config.secretKey. The stored
// format is `iv:authTag:ciphertext`, all base64. Decryption verifies the auth tag,
// so tampered ciphertext throws rather than yielding garbage.
import crypto from 'node:crypto';
import { config } from './config.js';

function key(): Buffer {
  if (!config.secretKey) {
    throw new Error('APP_SECRET_KEY is not set — it is required to store linked-account credentials.');
  }
  // Normalize any-length secret to a 32-byte key.
  return crypto.createHash('sha256').update(config.secretKey).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(blob: string): string {
  const [ivB, tagB, ctB] = String(blob).split(':');
  if (!ivB || !tagB || !ctB) throw new Error('Malformed encrypted secret.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}
