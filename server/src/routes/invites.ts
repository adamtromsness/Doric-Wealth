import { Router } from 'express';
import { one, withTransaction } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hashToken } from '../auth.js';
import { requireAuth, mePayload } from '../tenant.js';
import { rateLimit } from '../rateLimit.js';

export const invites = Router();

// Limit invite preview/accept to deter code guessing (codes are already high-entropy).
const inviteLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'invite:', message: 'Too many invite attempts. Please wait and try again.' });
invites.use(inviteLimiter);

function inviteUsable(inv: any): boolean {
  if (!inv || inv.revoked) return false;
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return false;
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return false;
  return true;
}

// Public preview: just the book name so the joiner knows what they're joining.
// Leaks nothing else. No auth required (so the link can be opened before login).
invites.get(
  '/:code',
  ah(async (req, res) => {
    const inv = await one<any>(
      `SELECT i.*, h.name AS book_name
         FROM invites i JOIN books h ON h.id = i.book_id
        WHERE i.code = $1`,
      [req.params.code]
    );
    if (!inviteUsable(inv)) throw new HttpError(404, 'This invite link is invalid or has expired.');
    res.json({ book_name: inv.book_name, role: inv.role });
  })
);

// Accept an invite: join the book and switch to it. Requires a logged-in user.
invites.post(
  '/:code/accept',
  requireAuth,
  ah(async (req, res) => {
    const bookId = await withTransaction(async (client) => {
      const inv = (await client.query(`SELECT * FROM invites WHERE code = $1 FOR UPDATE`, [req.params.code])).rows[0];
      if (!inviteUsable(inv)) throw new HttpError(404, 'This invite link is invalid or has expired.');
      const hid = inv.book_id;

      const already = (await client.query(
        `SELECT id FROM memberships WHERE user_id = $1 AND book_id = $2`,
        [req.user!.id, hid]
      )).rows[0];
      if (!already) {
        await client.query(
          `INSERT INTO memberships (user_id, book_id, role) VALUES ($1,$2,$3)`,
          [req.user!.id, hid, inv.role]
        );
        await client.query(`UPDATE invites SET uses = uses + 1 WHERE id = $1`, [inv.id]);
      }
      // Make the joined book active on this session.
      if (req.sessionToken) {
        await client.query(`UPDATE sessions SET active_book_id = $2 WHERE token_hash = $1`, [hashToken(req.sessionToken), hid]);
      }
      return hid;
    });

    res.json(await mePayload(req.user!.id, bookId));
  })
);
