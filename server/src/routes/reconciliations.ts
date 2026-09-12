import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { integerId, optionalDateOnly, optionalMoney, optionalEnumValue, optionalBoolean, assertOwned } from '../validation.js';

export const reconciliations = Router();

const RECON_STATUS = ['open', 'completed', 'canceled'] as const;

// Confirm a reconciliation session belongs to the active book, or 404.
async function ownedSession(id: unknown, bookId: number): Promise<any> {
  const s = await one(`SELECT * FROM reconciliation_sessions WHERE id = $1 AND book_id = $2`, [id, bookId]);
  if (!s) throw new HttpError(404, 'Reconciliation session not found');
  return s;
}

// Create a reconciliation session for an account in the active book.
reconciliations.post(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const account_id = integerId(req.body?.account_id, 'account_id');
    // Rejects an account from another book (404) before the insert.
    await assertOwned('account', account_id, bookId);
    const statement_start = optionalDateOnly(req.body?.statement_start, 'statement_start');
    const statement_end = optionalDateOnly(req.body?.statement_end, 'statement_end');
    const statement_balance = optionalMoney(req.body?.statement_balance, 'statement_balance');
    const row = await one(
      `INSERT INTO reconciliation_sessions
         (book_id, account_id, statement_start, statement_end, statement_balance, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [bookId, account_id, statement_start, statement_end, statement_balance, req.user?.id ?? null]
    );
    res.status(201).json(row);
  })
);

// List sessions, optionally filtered by account.
reconciliations.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const params: any[] = [bookId];
    let where = `book_id = $1`;
    if (req.query.account_id) { params.push(Number(req.query.account_id)); where += ` AND account_id = $${params.length}`; }
    res.json(await query(`SELECT * FROM reconciliation_sessions WHERE ${where} ORDER BY started_at DESC, id DESC`, params));
  })
);

reconciliations.get(
  '/:id',
  ah(async (req, res) => {
    res.json(await ownedSession(req.params.id, hh(req)));
  })
);

// Update a session's status / statement fields. Completing stamps completed_at;
// reopening or canceling clears it.
reconciliations.put(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedSession(req.params.id, bookId);
    const status = optionalEnumValue(req.body?.status, 'status', RECON_STATUS);
    const statement_start = optionalDateOnly(req.body?.statement_start, 'statement_start');
    const statement_end = optionalDateOnly(req.body?.statement_end, 'statement_end');
    const statement_balance = optionalMoney(req.body?.statement_balance, 'statement_balance');
    const row = await one(
      `UPDATE reconciliation_sessions SET
         status = COALESCE($2, status),
         statement_start = COALESCE($3, statement_start),
         statement_end = COALESCE($4, statement_end),
         statement_balance = COALESCE($5, statement_balance),
         completed_at = CASE WHEN $2 = 'completed' THEN COALESCE(completed_at, now())
                             WHEN $2 IN ('open','canceled') THEN NULL
                             ELSE completed_at END
       WHERE id = $1 AND book_id = $6 RETURNING *`,
      [req.params.id, status, statement_start, statement_end, statement_balance, bookId]
    );
    res.json(row);
  })
);

// --- Cleared items (transactions associated with a session) ---
reconciliations.get(
  '/:id/items',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedSession(req.params.id, bookId);
    res.json(await query(
      `SELECT ri.*, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.merchant, t.description
         FROM reconciliation_items ri JOIN transactions t ON t.id = ri.transaction_id
        WHERE ri.session_id = $1 AND ri.book_id = $2 ORDER BY ri.id`,
      [req.params.id, bookId]
    ));
  })
);

// Mark a transaction cleared in a session (idempotent on session+transaction).
reconciliations.post(
  '/:id/items',
  ah(async (req, res) => {
    const bookId = hh(req);
    const session = await ownedSession(req.params.id, bookId);
    const transaction_id = integerId(req.body?.transaction_id, 'transaction_id');
    const txn = await one<{ account_id: number; transfer_account_id: number | null }>(
      `SELECT account_id, transfer_account_id FROM transactions WHERE id = $1 AND book_id = $2`,
      [transaction_id, bookId]
    );
    if (!txn) throw new HttpError(404, 'Transaction not found in this book.');
    // The session is account-specific: only allow a transaction that posts to the
    // session's account, either directly or as the other side of a transfer.
    if (txn.account_id !== session.account_id && txn.transfer_account_id !== session.account_id) {
      throw new HttpError(400, "Transaction does not belong to this reconciliation session's account.");
    }
    const cleared = optionalBoolean(req.body?.cleared, 'cleared') ?? true;
    const row = await one(
      `INSERT INTO reconciliation_items (book_id, session_id, transaction_id, cleared)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (session_id, transaction_id) DO UPDATE SET cleared = EXCLUDED.cleared
       RETURNING *`,
      [bookId, req.params.id, transaction_id, cleared]
    );
    res.status(201).json(row);
  })
);

reconciliations.delete(
  '/:id/items/:itemId',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedSession(req.params.id, bookId);
    await query(`DELETE FROM reconciliation_items WHERE id = $1 AND session_id = $2 AND book_id = $3`, [req.params.itemId, req.params.id, bookId]);
    res.status(204).end();
  })
);
