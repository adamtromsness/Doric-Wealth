// Password reset links: single-use, time-limited, and only a SHA-256 hash of the
// token is stored. Created when a user asks ("Forgot password?", emailed) or by the
// operator (CLI, for a user without email set up). Completing a reset sets the new
// password, uses up the link (and any other open links for that user), and signs the
// user out everywhere.
//
// CLI (operator):
//   npm run reset-link -- person@example.com [--hours 24]
//   In the production image: node dist/passwordReset.js person@example.com [--hours 24]
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { hashToken, hashPassword, destroyOtherSessions } from './auth.js';
import { HttpError } from './http.js';
import { withTransaction } from './db.js';

export const EMAIL_LINK_MINUTES = 60;
export const ADMIN_LINK_HOURS = 24;
const INVALID = 'This reset link is invalid, expired, or already used. Ask for a new one.';

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export function resetUrl(token: string): string {
  const path = `/reset-password?token=${token}`;
  return config.appBaseUrl ? `${config.appBaseUrl.replace(/\/$/, '')}${path}` : path;
}

// Create a link for a user. Older unused links for that user stop working.
export async function createResetToken(db: Queryable, userId: number, via: 'email' | 'admin', minutes: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, via, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, hashToken(token), via, minutes]
  );
  return token;
}

// The account a still-valid link is for (email partly masked), or null.
export async function checkResetToken(db: Queryable, token: string): Promise<{ email: string } | null> {
  const row = (await db.query(
    `SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()`,
    [hashToken(token)]
  )).rows[0];
  return row ? { email: maskEmail(row.email) } : null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const shown = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(1, Math.min(local.length - shown.length, 6)))}@${domain}`;
}

// Set the new password with a valid link. Throws a 400 for a bad or used link.
export async function completeReset(token: string, newPasswordHash: { hash: string; salt: string }): Promise<number> {
  const userId = await withTransaction(async (client) => {
    const row = (await client.query(
      `SELECT id, user_id FROM password_resets
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashToken(token)]
    )).rows[0];
    if (!row) throw new HttpError(400, INVALID);
    await client.query(`UPDATE users SET password_hash = $2, password_salt = $3 WHERE id = $1`,
      [row.user_id, newPasswordHash.hash, newPasswordHash.salt]);
    await client.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [row.id]);
    await client.query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]);
    return row.user_id as number;
  });
  await destroyOtherSessions(userId); // sign out everywhere
  return userId;
}

export { hashPassword };

// CLI entry point (skipped when imported).
export async function runCli(argv: string[], pool: pg.Pool, log: (s: string) => void = console.log): Promise<void> {
  const email = (argv.find((a) => !a.startsWith('--')) ?? '').trim();
  if (!email) throw new Error('Usage: <email> [--hours 24]');
  const i = argv.indexOf('--hours');
  const hours = i === -1 ? ADMIN_LINK_HOURS : Number(argv[i + 1]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('--hours must be a whole number from 1 to 168');
  const user = (await pool.query(`SELECT id, email FROM users WHERE lower(email) = lower($1)`, [email])).rows[0];
  if (!user) throw new Error(`No account with the email ${email}.`);
  const token = await createResetToken(pool, user.id, 'admin', hours * 60);
  log(`Password reset link for ${user.email}, valid for ${hours} hour${hours === 1 ? '' : 's'} and one use:`);
  log(`  ${resetUrl(token)}`);
  log('Send it to them directly. Using it signs them out of every device.');
}

if (process.argv[1] && /passwordReset\.(ts|js)$/.test(process.argv[1])) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  runCli(process.argv.slice(2), pool)
    .catch((err) => { console.error(`reset-link: ${err.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
