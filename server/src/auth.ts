// Self-contained auth primitives: password hashing (scrypt, no native deps),
// opaque server-side sessions (only a hash of the token is stored), and cookie
// helpers. Swap scrypt for argon2 later by reimplementing hash/verifyPassword.
import crypto from 'node:crypto';
import type { Request, CookieOptions } from 'express';
import { one, query } from './db.js';
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

// Revoke every session for a user, optionally sparing the one making the request
// so "sign out everywhere" doesn't log the caller out of the tab they're using.
// Returns how many sessions were ended. This is the lever a user needs after a
// stolen laptop or a shared password, and the hook a future password-change route
// should call so a changed password actually evicts an attacker.
export async function destroyOtherSessions(userId: number, keepToken?: string): Promise<number> {
  const rows = keepToken
    ? await query<{ id: number }>(
        `DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING id`,
        [userId, hashToken(keepToken)]
      )
    : await query<{ id: number }>(`DELETE FROM sessions WHERE user_id = $1 RETURNING id`, [userId]);
  return rows.length;
}

// Expired sessions are already refused at read time, but nothing deleted them, so
// the table grew forever and kept stale token hashes on disk. Swept periodically
// from the server's boot timer.
export async function deleteExpiredSessions(): Promise<number> {
  const rows = await query<{ id: number }>(`DELETE FROM sessions WHERE expires_at < now() RETURNING id`);
  return rows.length;
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
