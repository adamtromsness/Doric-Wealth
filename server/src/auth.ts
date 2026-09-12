// Self-contained auth primitives: password hashing (scrypt, no native deps),
// opaque server-side sessions (only a hash of the token is stored), and cookie
// helpers. Swap scrypt for argon2 later by reimplementing hash/verifyPassword.
import crypto from 'node:crypto';
import type { Request, CookieOptions } from 'express';
import { one } from './db.js';
import { config } from './config.js';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const computed = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== computed.length) return false;
  return crypto.timingSafeEqual(stored, computed);
}

// --- Sessions ---
export const SESSION_COOKIE = 'ft_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Create a session row and return the raw token (only its hash is persisted).
export async function createSession(userId: number, activeBookId: number | null): Promise<string> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await one(
    `INSERT INTO sessions (user_id, token_hash, active_book_id, expires_at)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, hashToken(token), activeBookId, expires]
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await one(`DELETE FROM sessions WHERE token_hash = $1 RETURNING id`, [hashToken(token)]);
}

// A short, human-shareable, URL-safe invite code.
export function newInviteCode(): string {
  return crypto.randomBytes(9).toString('base64url'); // ~12 chars
}

// --- Cookies ---
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
