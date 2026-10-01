// Manage signup invites: single-use codes that let a new person create a Doric
// account with their own books when sign-up is invite-only (the production default).
// Runs as the privileged role, like bootstrap.
//
// Usage:
//   npm run invite -- create [--email person@example.com] [--days 14] [--note "Mom"]
//   npm run invite -- list
//   npm run invite -- revoke <id>
// In the production image: node dist/signupInvites.js <same arguments>
// (locally: scripts/local-prod/invite.sh <same arguments>).
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { hashToken } from './auth.js';

const DEFAULT_DAYS = 14;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function newSignupCode(): string {
  return crypto.randomBytes(18).toString('base64url'); // 24 chars, 144 bits
}

export function signupUrl(code: string): string {
  const path = `/register?code=${code}`;
  return config.appBaseUrl ? `${config.appBaseUrl.replace(/\/$/, '')}${path}` : path;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
}

function status(r: any): string {
  if (r.used_at) return `used ${r.used_at.toISOString().slice(0, 10)}${r.used_by_email ? ` by ${r.used_by_email}` : ''}`;
  if (r.revoked_at) return 'revoked';
  if (r.expires_at && r.expires_at.getTime() < Date.now()) return 'expired';
  return `open until ${r.expires_at ? r.expires_at.toISOString().slice(0, 10) : 'never'}`;
}

export async function run(argv: string[], pool: pg.Pool, log: (s: string) => void = console.log): Promise<void> {
  const [cmd, ...args] = argv;
  if (cmd === 'create') {
    const email = flag(args, 'email')?.trim() || null;
    if (email && !EMAIL_RE.test(email)) throw new Error(`Not a valid email address: ${email}`);
    const days = Number(flag(args, 'days') ?? DEFAULT_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be a whole number from 1 to 365');
    const note = flag(args, 'note')?.trim() || null;
    const code = newSignupCode();
    const row = (await pool.query(
      `INSERT INTO signup_invites (code_hash, email, note, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id, expires_at`,
      [hashToken(code), email, note, days]
    )).rows[0];
    log(`Created signup invite #${row.id}${email ? ` for ${email}` : ''}, valid until ${row.expires_at.toISOString().slice(0, 10)}.`);
    log(`Send this link (it is shown only once, and works for one sign-up):`);
    log(`  ${signupUrl(code)}`);
    return;
  }
  if (cmd === 'list') {
    const rows = (await pool.query(
      `SELECT si.*, u.email AS used_by_email FROM signup_invites si
         LEFT JOIN users u ON u.id = si.used_by ORDER BY si.id`
    )).rows;
    if (!rows.length) { log('No signup invites yet.'); return; }
    for (const r of rows) {
      log(`#${r.id}  ${r.email ?? '(any email)'}  ${status(r)}${r.note ? `  - ${r.note}` : ''}`);
    }
    return;
  }
  if (cmd === 'revoke') {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Usage: revoke <id>  (see: list)');
    const row = (await pool.query(
      `UPDATE signup_invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [id]
    )).rows[0];
    if (!row) throw new Error(`Signup invite #${id} not found, already used, or already revoked.`);
    log(`Revoked signup invite #${id}.`);
    return;
  }
  throw new Error('Usage: create [--email x] [--days N] [--note text] | list | revoke <id>');
}

// CLI entry point (skipped when imported by tests).
if (process.argv[1] && /signupInvites\.(ts|js)$/.test(process.argv[1])) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  run(process.argv.slice(2), pool)
    .catch((err) => { console.error(`invite: ${err.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
