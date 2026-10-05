import { Router } from 'express';
import { one, query, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hashToken, newInviteCode } from '../auth.js';
import { requireAuth, membershipRole, mePayload } from '../tenant.js';
import { config } from '../config.js';
import { integerId } from '../validation.js';

export const books = Router();

books.use(requireAuth);

// Set the caller's active book on their current session.
async function setActiveBook(token: string | undefined, bookId: number) {
  if (!token) return;
  await one(`UPDATE sessions SET active_book_id = $2 WHERE token_hash = $1 RETURNING id`, [hashToken(token), bookId]);
}

// Books the caller belongs to.
books.get(
  '/',
  ah(async (req, res) => {
    const rows = await query(
      `SELECT h.id, h.name, m.role
         FROM memberships m JOIN books h ON h.id = m.book_id
        WHERE m.user_id = $1 ORDER BY h.id`,
      [req.user!.id]
    );
    res.json(rows);
  })
);

// Create a new book owned by the caller, and make it active.
books.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, 'A name is required.');
    // Create the book and the owner membership atomically — a membership-insert
    // failure must not leave an orphan book (the list inner-joins memberships, so
    // an orphan would be permanently invisible and unrecoverable).
    const id = await withTransaction(async (client) => {
      const book = (await client.query(`INSERT INTO books (name) VALUES ($1) RETURNING id`, [name])).rows[0];
      await client.query(`INSERT INTO memberships (user_id, book_id, role) VALUES ($1,$2,'owner')`, [req.user!.id, book.id]);
      return book.id as number;
    });
    await setActiveBook(req.sessionToken, id);
    res.status(201).json(await mePayload(req.user!.id, id));
  })
);

// Switch the active book (must be a member).
books.post(
  '/switch',
  ah(async (req, res) => {
    const bookId = Number(req.body?.book_id);
    if (!Number.isFinite(bookId)) throw new HttpError(400, 'book_id is required.');
    const role = await membershipRole(req.user!.id, bookId);
    if (!role) throw new HttpError(403, 'You are not a member of that book.');
    await setActiveBook(req.sessionToken, bookId);
    res.json(await mePayload(req.user!.id, bookId));
  })
);

// Require the caller to be owner/admin of the :id book.
async function requireManager(req: any, bookId: number): Promise<string> {
  const role = await membershipRole(req.user!.id, bookId);
  if (!role) throw new HttpError(403, 'You are not a member of that book.');
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, 'Only an owner or admin can manage members.');
  return role;
}

// Rename a book / set of books (owner or admin only).
books.put(
  '/:id',
  ah(async (req, res) => {
    const bookId = Number(req.params.id);
    await requireManager(req, bookId);
    require_(req.body, ['name']);
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, 'A name is required.');
    await one(`UPDATE books SET name = $2 WHERE id = $1 RETURNING id`, [bookId, name]);
    res.json(await mePayload(req.user!.id, req.book?.id ?? bookId));
  })
);

books.get(
  '/:id/members',
  ah(async (req, res) => {
    const bookId = Number(req.params.id);
    if (!(await membershipRole(req.user!.id, bookId))) throw new HttpError(403, 'You are not a member of that book.');
    const rows = await query(
      `SELECT u.id, u.email, u.name, u.last_login_at, m.role, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.book_id = $1 ORDER BY m.created_at`,
      [bookId]
    );
    res.json(rows);
  })
);

// Remove someone from a book, or leave it yourself. Owners and admins can remove
// members; only an owner can remove another owner; the last owner can't be removed
// (or leave). Access ends on the removed person's next request: every request
// re-checks membership (tenant.ts authContext).
books.delete(
  '/:id/members/:userId',
  ah(async (req, res) => {
    const bookId = integerId(req.params.id, 'id');
    const targetId = integerId(req.params.userId, 'userId');
    const self = targetId === req.user!.id;
    const myRole = await membershipRole(req.user!.id, bookId);
    if (!myRole) throw new HttpError(403, 'You are not a member of that book.');
    await withTransaction(async (client) => {
      // Lock the book's memberships so two removals can't both pass the last-owner check.
      const members = (await client.query(`SELECT user_id, role FROM memberships WHERE book_id = $1 FOR UPDATE`, [bookId])).rows;
      const target = members.find((m: any) => m.user_id === targetId);
      if (!target) throw new HttpError(404, 'That person is not a member of these books.');
      if (!self) {
        if (myRole !== 'owner' && myRole !== 'admin') throw new HttpError(403, 'Only an owner or admin can remove members.');
        if (target.role === 'owner' && myRole !== 'owner') throw new HttpError(403, 'Only an owner can remove another owner.');
      }
      if (target.role === 'owner' && members.filter((m: any) => m.role === 'owner').length === 1) {
        throw new HttpError(409, self
          ? "You're the only owner of these books, so you can't leave them. Make someone else an owner first."
          : "That's the only owner of these books, so they can't be removed.");
      }
      await client.query(`DELETE FROM memberships WHERE book_id = $1 AND user_id = $2`, [bookId, targetId]);
    });
    res.json({ ok: true });
  })
);

function inviteUrl(code: string): string {
  return config.appBaseUrl ? `${config.appBaseUrl.replace(/\/$/, '')}/accept?code=${code}` : `/accept?code=${code}`;
}

export const INVITE_DAYS = 7;

// Create a shareable invite for the book (owner/admin only).
books.post(
  '/:id/invites',
  ah(async (req, res) => {
    const bookId = Number(req.params.id);
    await requireManager(req, bookId);
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    // Safe defaults: a link works once and expires in INVITE_DAYS, so a forwarded or
    // leaked link can't be used indefinitely. Explicit values may be passed.
    let expires_at = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    if (req.body?.expires_at != null && req.body.expires_at !== '') {
      expires_at = new Date(req.body.expires_at);
      if (Number.isNaN(expires_at.getTime()) || expires_at.getTime() <= Date.now()) throw new HttpError(400, 'expires_at must be a future date.');
    }
    let max_uses = 1;
    if (req.body?.max_uses != null && req.body.max_uses !== '') {
      max_uses = Number(req.body.max_uses);
      if (!Number.isInteger(max_uses) || max_uses < 1 || max_uses > 50) throw new HttpError(400, 'max_uses must be a whole number from 1 to 50.');
    }
    const code = newInviteCode();
    const row = await one<any>(
      `INSERT INTO invites (book_id, code, role, created_by, expires_at, max_uses)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [bookId, code, role, req.user!.id, expires_at, max_uses]
    );
    res.status(201).json({ ...row, url: inviteUrl(code) });
  })
);

books.get(
  '/:id/invites',
  ah(async (req, res) => {
    const bookId = Number(req.params.id);
    await requireManager(req, bookId);
    const rows = await query(
      `SELECT * FROM invites
        WHERE book_id = $1 AND NOT revoked
          AND (expires_at IS NULL OR expires_at > now())
          AND (max_uses IS NULL OR uses < max_uses)
        ORDER BY created_at DESC`,
      [bookId]
    );
    res.json(rows.map((r: any) => ({ ...r, url: inviteUrl(r.code) })));
  })
);

books.delete(
  '/:id/invites/:inviteId',
  ah(async (req, res) => {
    const bookId = Number(req.params.id);
    await requireManager(req, bookId);
    await one(`UPDATE invites SET revoked = true WHERE id = $1 AND book_id = $2 RETURNING id`, [req.params.inviteId, bookId]);
    res.status(204).end();
  })
);
