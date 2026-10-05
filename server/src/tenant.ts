// Per-request tenant context. `authContext` resolves the session cookie into the
// current user + active book and attaches them to the request; the guards
// gate routes. Tenant-scoped routes read `hh(req)` and add `book_id = $n` to
// every query (see routes/accounts.ts for the canonical pattern).
import type { Request, Response, NextFunction } from 'express';
import { one, query, pool, requestStore, type RequestBinding } from './db.js';
import { HttpError } from './http.js';
import { SESSION_COOKIE, readCookie, hashToken } from './auth.js';

export interface AuthUser { id: number; email: string; name: string | null; timezone: string | null }
export interface ActiveBook { id: number; role: string; name: string }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      book?: ActiveBook;
      sessionToken?: string;
    }
  }
}

export async function authContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next();
    const sess = await one<any>(
      `SELECT s.id, s.user_id, s.active_book_id, s.expires_at, u.email, u.name, u.timezone
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashToken(token)]
    );
    if (!sess || new Date(sess.expires_at).getTime() < Date.now()) return next();

    req.user = { id: sess.user_id, email: sess.email, name: sess.name, timezone: sess.timezone ?? null };
    req.sessionToken = token;

    // Resolve the active book — must be a book the user still belongs to.
    let mem = sess.active_book_id
      ? await one<any>(
          `SELECT m.book_id, m.role, h.name
             FROM memberships m JOIN books h ON h.id = m.book_id
            WHERE m.user_id = $1 AND m.book_id = $2`,
          [sess.user_id, sess.active_book_id]
        )
      : null;
    if (!mem) {
      mem = await one<any>(
        `SELECT m.book_id, m.role, h.name
           FROM memberships m JOIN books h ON h.id = m.book_id
          WHERE m.user_id = $1 ORDER BY m.book_id LIMIT 1`,
        [sess.user_id]
      );
    }
    if (mem) req.book = { id: mem.book_id, role: mem.role, name: mem.name };
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

// Bind a dedicated DB connection to the request and set the `app.book_id`
// GUC on it, so Postgres row-level security scopes every statement to the active
// book (defense-in-depth behind the app-layer WHERE clauses). The RLS policies
// read this exact GUC name via current_setting('app.book_id'). The connection is
// released when the response finishes. Requests without an active book fall
// through and use the shared pool (RLS then default-denies tenant tables).
export function tenantDb(req: Request, res: Response, next: NextFunction) {
  if (!req.book) return next();
  pool.connect().then(
    (client) => {
      const binding: RequestBinding = { client };
      // Once released, the binding refuses further queries (see db.ts), so code still
      // running for this request can't use a connection another request now owns.
      //  - Response finished: reset the tenant settings and return the connection to
      //    the pool; if the reset fails, discard the connection instead.
      //  - Client went away before the response finished (aborted): the handler may
      //    still be mid-query, so discard the connection rather than reuse it.
      const release = (aborted: boolean) => {
        if (binding.released) return;
        binding.released = true;
        if (aborted) { client.release(true); return; }
        client.query('RESET ALL').then(() => client.release(), (e) => client.release(e));
      };
      res.on('finish', () => release(false));
      res.on('close', () => release(!res.writableFinished));
      client.query(
        `SELECT set_config('app.book_id', $1, false), set_config('app.user_id', $2, false)`,
        [String(req.book!.id), String(req.user?.id ?? '')]
      )
        .then(() => requestStore.run(binding, () => next()))
        .catch((e) => { release(true); next(e); });
    },
    (err) => next(err)
  );
}

// Most data routes need both a user and an active book.
export function requireBook(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  if (!req.book) return next(new HttpError(403, 'No active book'));
  next();
}

// Active-book id for tenant-scoped queries. Throws if no active book.
export function hh(req: Request): number {
  if (!req.book) throw new HttpError(403, 'No active book');
  return req.book.id;
}

// Guard for owner/admin-only operations (destructive or account-wide actions like
// backup import/purge/export and member management). The caller's role is already
// resolved onto req.book by authContext, so this needs no extra DB round-trip.
// Throws 403 for plain members. Use inside a handler: `requireManager(req)`.
export function requireManager(req: Request): void {
  const role = req.book?.role;
  if (role !== 'owner' && role !== 'admin') {
    throw new HttpError(403, 'Only an owner or admin can perform this action.');
  }
}

// The caller's role in a specific book, or null if not a member.
export async function membershipRole(userId: number, bookId: number): Promise<string | null> {
  const m = await one<{ role: string }>(
    `SELECT role FROM memberships WHERE user_id = $1 AND book_id = $2`,
    [userId, bookId]
  );
  return m?.role ?? null;
}

// Standard { user, books, activeBook } payload used by every auth response.
export async function mePayload(userId: number, activeBookId: number | null) {
  const user = await one(`SELECT id, email, name, first_name, middle_name, last_name, preferred_name, to_char(dob, 'YYYY-MM-DD') AS dob, timezone FROM users WHERE id = $1`, [userId]);
  const books = await query(
    `SELECT h.id, h.name, m.role
       FROM memberships m JOIN books h ON h.id = m.book_id
      WHERE m.user_id = $1 ORDER BY h.id`,
    [userId]
  );
  const activeBook =
    books.find((h: any) => h.id === activeBookId) ?? books[0] ?? null;
  return { user, books, activeBook };
}
