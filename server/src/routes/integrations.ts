import { Router } from 'express';
import { one } from '../db.js';
import { ah } from '../http.js';
import { hh, requireManager } from '../tenant.js';
import { encodeKeyAtRest, decodeKeyAtRest } from '../secrets.js';
import { config } from '../config.js';

// Book-level third-party integrations (Integrations → RentCast). The key belongs to
// the active book: any member can see whether it's configured; only owners/admins can
// change it. The key itself is never returned, only a masked hint.
export const integrations = Router();

async function rentcastStatus(bookId: number, canManage: boolean) {
  const row = await one<{ rentcast_api_key: string | null }>(`SELECT rentcast_api_key FROM books WHERE id = $1`, [bookId]);
  const key = decodeKeyAtRest(row?.rentcast_api_key, 'RentCast API key');
  return {
    configured: Boolean(key || config.rentcastApiKey),
    book_key_set: Boolean(key),
    key_hint: key ? `…${key.slice(-4)}` : null,
    server_fallback: Boolean(config.rentcastApiKey),
    can_manage: canManage,
  };
}

const isManager = (req: any) => req.book?.role === 'owner' || req.book?.role === 'admin';

integrations.get('/rentcast', ah(async (req, res) => {
  res.json(await rentcastStatus(hh(req), isManager(req)));
}));

// Set (api_key: "...") or clear (api_key: "") the book's RentCast key.
integrations.put('/rentcast', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const raw = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  await one(`UPDATE books SET rentcast_api_key = $2 WHERE id = $1 RETURNING id`, [bookId, raw ? encodeKeyAtRest(raw) : null]);
  res.json(await rentcastStatus(bookId, true));
}));
