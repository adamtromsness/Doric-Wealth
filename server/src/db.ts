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
// `inTransaction` marks a binding that is already inside a transaction (background
// jobs, see withBookContext); withTransaction then nests with a savepoint.
// `released` is set when the request's connection has gone back to the pool (or been
// discarded): any later query from that request's code fails instead of running on a
// connection that may now belong to another request (and another book).
export interface RequestBinding { client: pg.PoolClient; inTransaction?: boolean; released?: boolean }
export const requestStore = new AsyncLocalStorage<RequestBinding>();

export class ReleasedConnectionError extends Error {
  constructor() { super('This request has ended; its database connection was released.'); this.name = 'ReleasedConnectionError'; }
}
function bound(): pg.PoolClient | undefined {
  const store = requestStore.getStore();
  if (store?.released) throw new ReleasedConnectionError();
  return store?.client;
}

type Queryable = Pick<pg.PoolClient, 'query'>;
function runner(): Queryable {
  return bound() ?? pool;
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await runner().query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export type TxOptions = {
  // 'repeatable read' gives every statement in the transaction the same snapshot of
  // committed data (e.g. a multi-table export that must be internally consistent).
  isolation?: 'repeatable read' | 'serializable';
  readOnly?: boolean;
};
const beginSql = (o: TxOptions = {}) =>
  `BEGIN${o.isolation ? ` ISOLATION LEVEL ${o.isolation.toUpperCase()}` : ''}${o.readOnly ? ' READ ONLY' : ''}`;

let savepointSeq = 0;

// Run `fn` inside a transaction. When a request connection is bound (the common
// case for API handlers), the transaction runs on it so the RLS GUC stays in
// effect; otherwise a fresh pooled connection is used and released. If the bound
// connection is already inside a transaction (a background job), this nests with a
// savepoint instead of issuing a second BEGIN, whose COMMIT would end the outer one.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const store = requestStore.getStore();
  const boundClient = bound();
  if (boundClient && store?.inTransaction) {
    const sp = `sp_${++savepointSeq}`;
    await boundClient.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(boundClient);
      await boundClient.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (e) {
      await boundClient.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      throw e;
    }
  }
  if (boundClient) {
    await boundClient.query(beginSql(opts));
    try {
      const result = await fn(boundClient);
      await boundClient.query('COMMIT');
      return result;
    } catch (e) {
      await boundClient.query('ROLLBACK');
      throw e;
    }
  }
  const client = await pool.connect();
  try {
    await client.query(beginSql(opts));
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

// Run a background job (no HTTP request in scope) for one book: a dedicated
// connection, one transaction, and app.book_id set transaction-locally so row-level
// security applies exactly as in a request. query/one/withTransaction inside `fn` use
// this connection automatically. Without this, job queries run on the shared pool
// with no tenant context, and under the production (non-superuser) role RLS hides
// every tenant row: reads come back empty and nothing fails loudly.
// Per-book advisory lock (class BOOK_LOCK, id = book id). Everything that works on a
// book's data (requests, background jobs) holds it shared; a restore takes it
// exclusively, so it waits for work in flight and holds off new work on that book
// until it commits. Taken first, before any other lock, so it can't deadlock with them.
export const BOOK_LOCK = 4242;

export async function withBookContext<T>(bookId: number, fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(beginSql(opts));
    try {
      await client.query(`SELECT set_config('app.book_id', $1, true), pg_advisory_xact_lock_shared(${BOOK_LOCK}, $2)`, [String(bookId), bookId]);
      const result = await requestStore.run({ client, inTransaction: true }, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}
