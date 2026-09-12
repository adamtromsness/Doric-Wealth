// One-time bootstrap: create the first owner user and attach them to the legacy
// book (the one that adopted the pre-existing single-tenant data in migration
// 039), so the operator's existing accounts/transactions become accessible behind
// a real login. Idempotent: re-running with the same email is a no-op.
//
// Usage:
//   EMAIL=you@example.com PASSWORD=secret123 NAME="You" npm run bootstrap
//   npm run bootstrap -- you@example.com secret123 "You"
import pg from 'pg';
import { config } from './config.js';
import { hashPassword } from './auth.js';

// Bootstrap runs as the privileged role (it predates / sets up logins).
const pool = new pg.Pool({ connectionString: config.databaseUrl });
async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const r = await pool.query(text, params);
  return (r.rows[0] as T) ?? null;
}

async function run() {
  const email = (process.env.EMAIL ?? process.argv[2] ?? '').trim();
  const password = process.env.PASSWORD ?? process.argv[3] ?? '';
  const name = (process.env.NAME ?? process.argv[4] ?? '').trim() || null;

  if (!email || !password) {
    console.error('Usage: EMAIL=.. PASSWORD=.. [NAME=..] npm run bootstrap');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  // Reuse the oldest book (the legacy/adopted one) or create it.
  let hh = await one<{ id: number }>(`SELECT id FROM books ORDER BY id LIMIT 1`);
  if (!hh) {
    hh = await one<{ id: number }>(`INSERT INTO books (name) VALUES ('My Book') RETURNING id`);
    console.log(`Created book #${hh!.id} "My Book".`);
  }
  const bookId = hh!.id;

  const existing = await one<{ id: number }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
  let userId: number;
  if (existing) {
    userId = existing.id;
    console.log(`User ${email} already exists (#${userId}).`);
  } else {
    const { hash, salt } = hashPassword(password);
    userId = (await one<{ id: number }>(
      `INSERT INTO users (email, name, password_hash, password_salt) VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, name, hash, salt]
    ))!.id;
    console.log(`Created user ${email} (#${userId}).`);
  }

  const member = await one(`SELECT id FROM memberships WHERE user_id = $1 AND book_id = $2`, [userId, bookId]);
  if (!member) {
    await one(`INSERT INTO memberships (user_id, book_id, role) VALUES ($1,$2,'owner') RETURNING id`, [userId, bookId]);
    console.log(`Added ${email} as owner of book #${bookId}.`);
  } else {
    console.log(`${email} is already a member of book #${bookId}.`);
  }

  console.log('Bootstrap complete. You can now log in.');
  await pool.end();
}

run().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
