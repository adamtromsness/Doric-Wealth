// Delete a person's account and their data, at their request (the Privacy page tells
// people to ask the operator). Books they're the only member of are deleted with
// everything in them; from books shared with others they're removed, and the books
// stay with the other members. If they're the only owner of a shared book, another
// member of it must be named with --new-owner to take it over; otherwise nothing is
// deleted.
//
// Without --yes it only prints what would happen.
//
// CLI (operator):
//   npm run delete-account -- person@example.com [--new-owner other@example.com] [--yes]
//   In the production image: node dist/deleteAccount.js person@example.com [...]
import pg from 'pg';
import { config } from './config.js';

type Plan = {
  user: { id: number; email: string };
  deleteBooks: { id: number; name: string }[];
  leaveBooks: { id: number; name: string }[];
  handOver: { id: number; name: string }[];
  blocked: { id: number; name: string }[];
  newOwner: { id: number; email: string } | null;
};

async function plan(db: pg.PoolClient | pg.Pool, email: string, newOwnerEmail: string | null): Promise<Plan> {
  const user = (await db.query(`SELECT id, email FROM users WHERE lower(email) = lower($1)`, [email])).rows[0];
  if (!user) throw new Error(`No account with the email ${email}.`);
  let newOwner = null;
  if (newOwnerEmail) {
    newOwner = (await db.query(`SELECT id, email FROM users WHERE lower(email) = lower($1)`, [newOwnerEmail])).rows[0];
    if (!newOwner) throw new Error(`No account with the email ${newOwnerEmail}.`);
    if (newOwner.id === user.id) throw new Error('--new-owner must be someone else.');
  }
  const books = (await db.query(
    `SELECT b.id, b.name, m.role,
            (SELECT count(*)::int FROM memberships o WHERE o.book_id = b.id) AS members,
            (SELECT count(*)::int FROM memberships o WHERE o.book_id = b.id AND o.role = 'owner') AS owners,
            EXISTS (SELECT 1 FROM memberships o WHERE o.book_id = b.id AND o.user_id = $2) AS has_new_owner
       FROM memberships m JOIN books b ON b.id = m.book_id
      WHERE m.user_id = $1 ORDER BY b.id FOR UPDATE OF m`,
    [user.id, newOwner?.id ?? null]
  )).rows;
  const p: Plan = { user, deleteBooks: [], leaveBooks: [], handOver: [], blocked: [], newOwner };
  for (const b of books) {
    const ref = { id: b.id, name: b.name };
    if (b.members === 1) p.deleteBooks.push(ref);
    else if (b.role === 'owner' && b.owners === 1) (b.has_new_owner ? p.handOver : p.blocked).push(ref);
    else p.leaveBooks.push(ref);
  }
  return p;
}

export async function runCli(argv: string[], pool: pg.Pool, log: (s: string) => void = console.log): Promise<void> {
  if (!argv.length) throw new Error('Usage: <email> [--new-owner <email>] [--yes]');
  const yes = argv.includes('--yes');
  const i = argv.indexOf('--new-owner');
  const newOwnerEmail = i === -1 ? null : (argv[i + 1] ?? '').trim();
  if (i !== -1 && (!newOwnerEmail || newOwnerEmail.startsWith('--'))) throw new Error('--new-owner needs an email');
  const email = (argv.find((a, j) => !a.startsWith('--') && !(i !== -1 && j === i + 1)) ?? '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!email) throw new Error('Usage: <email> [--new-owner <email>] [--yes]');
    const p = await plan(client, email, newOwnerEmail);
    const name = (b: { id: number; name: string }) => `"${b.name}" (#${b.id})`;
    log(`Account: ${p.user.email}`);
    for (const b of p.deleteBooks) log(`  delete book ${name(b)} and everything in it (they're its only member)`);
    for (const b of p.leaveBooks) log(`  remove them from shared book ${name(b)} (it stays with the other members)`);
    for (const b of p.handOver) log(`  make ${p.newOwner!.email} the owner of shared book ${name(b)}, then remove them from it`);
    for (const b of p.blocked) log(`  BLOCKED: they're the only owner of shared book ${name(b)}`);
    if (p.blocked.length) {
      throw new Error('Nothing was deleted. Name a member of each blocked book to take it over with --new-owner <email>, then run this again.');
    }
    if (!yes) {
      await client.query('ROLLBACK');
      log('Dry run: nothing was deleted. Run again with --yes to delete.');
      return;
    }
    for (const b of p.handOver) await client.query(`UPDATE memberships SET role = 'owner' WHERE book_id = $1 AND user_id = $2`, [b.id, p.newOwner!.id]);
    for (const b of p.deleteBooks) await client.query(`DELETE FROM books WHERE id = $1`, [b.id]);
    // Memberships, sessions and reset links go with the user (ON DELETE CASCADE);
    // "created by" references elsewhere are cleared (ON DELETE SET NULL).
    await client.query(`DELETE FROM users WHERE id = $1`, [p.user.id]);
    await client.query('COMMIT');
    log(`Deleted ${p.user.email}: ${p.deleteBooks.length} book${p.deleteBooks.length === 1 ? '' : 's'} deleted, removed from ${p.leaveBooks.length + p.handOver.length} shared.`);
    log('Server backups still hold this data until they age out (BACKUP_KEEP_DAYS, 30 days by default), including off-machine copies.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

if (process.argv[1] && /deleteAccount\.(ts|js)$/.test(process.argv[1])) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  runCli(process.argv.slice(2), pool)
    .catch((err) => { console.error(`delete-account: ${err.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
