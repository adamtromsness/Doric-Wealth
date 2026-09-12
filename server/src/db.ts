import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

// Postgres returns NUMERIC as strings to preserve precision. We convert to
// JS numbers at the API boundary so the frontend gets plain numbers. This is
// fine for personal-finance magnitudes; swap for a decimal library if you
// ever need exact cent arithmetic on very large sums.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

// The running app uses the (ideally non-superuser) app role so RLS is enforced.
// `idle_in_transaction_session_timeout` is defense-in-depth against a leaked or
// abandoned transaction pinning a pooled connection forever (pool starvation): a
// healthy request never sits idle mid-transaction, so a connection stuck >60s in
// that state is a bug and Postgres reclaims it. We deliberately do NOT set a global
// statement_timeout here because legitimate long jobs (backup export/import) run on
// this pool; gate those with their own per-statement timeout if needed.
export const pool = new pg.Pool({
  connectionString: config.appDatabaseUrl,
  max: config.dbPoolMax,
  options: '-c idle_in_transaction_session_timeout=60000',
});

// Fail closed before serving: row-level security is the PRIMARY tenant-isolation
// boundary, but a superuser / BYPASSRLS role silently disables it (FORCE ROW LEVEL
// SECURITY does not apply to such roles). If the app would connect with such a role,
// every cross-book query depends solely on the app-layer WHERE clauses — so in
// production we refuse to start; in dev we only warn. Also require an explicit,
// dedicated APP_DATABASE_URL in production (not the privileged migration role).
export async function assertSafeAppRole(): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !process.env.APP_DATABASE_URL) {
    throw new Error(
      'Refusing to start: APP_DATABASE_URL is not set in production. Configure a dedicated ' +
      'non-superuser app role (npm run setup:db-role) so Postgres row-level security is enforced.'
    );
  }
  const r = (await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )).rows[0];
  if (r && (r.rolsuper || r.rolbypassrls)) {
    const why = 'the app DB role can BYPASS row-level security (rolsuper/rolbypassrls).';
    if (isProd) {
      throw new Error(
        `Refusing to start: ${why} RLS is the primary tenant-isolation boundary — use a ` +
        'non-superuser role without BYPASSRLS for APP_DATABASE_URL (npm run setup:db-role).'
      );
    }
    console.warn(`Warning: ${why} Fine for local dev, but it MUST be a restricted role in production.`);
  }
}

// Per-request connection binding. The tenant middleware checks out one client,
// sets `app.book_id` on it (for row-level security), and runs the rest of
// the request inside this store. query/one/withTransaction then use that client
// automatically, so every statement in the request is tenant-scoped at the DB.
export const requestStore = new AsyncLocalStorage<{ client: pg.PoolClient }>();

type Queryable = Pick<pg.PoolClient, 'query'>;
function runner(): Queryable {
  return requestStore.getStore()?.client ?? pool;
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await runner().query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

// Run `fn` inside a transaction. When a request connection is bound (the common
// case for API handlers), the transaction runs on it so the RLS GUC stays in
// effect; otherwise a fresh pooled connection is used and released.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const bound = requestStore.getStore()?.client;
  if (bound) {
    await bound.query('BEGIN');
    try {
      const result = await fn(bound);
      await bound.query('COMMIT');
      return result;
    } catch (e) {
      await bound.query('ROLLBACK');
      throw e;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
