import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { integerId, optionalDateOnly, optionalMoney, optionalEnumValue, optionalBoolean, assertOwned } from '../validation.js';

export const reconciliations = Router();

const RECON_STATUS = ['open', 'completed', 'canceled'] as const;

// A statement reconciliation for one account:
//   cleared balance = opening balance + Σ cleared items (signed for the account,
//                     liability balances run the other way, as in ACCOUNT_BALANCES)
//   difference      = statement balance − cleared balance
// A session can only be completed when the difference is zero. Completing freezes the
// evidence (each cleared item's delta, amount, and dates, plus the cleared balance),
// and while it stays completed its items and statement can't change and the
// transactions it reconciled are guarded at the database (migration 129). Changing
// any of that requires an explicit reopen, recorded in reconciliation_events.

// Confirm a reconciliation session belongs to the active book, or 404.
async function ownedSession(id: unknown, bookId: number, client?: any): Promise<any> {
  const sql = `SELECT * FROM reconciliation_sessions WHERE id = $1 AND book_id = $2${client ? ' FOR UPDATE' : ''}`;
  const s = client ? (await client.query(sql, [id, bookId])).rows[0] : await one(sql, [id, bookId]);
  if (!s) throw new HttpError(404, 'Reconciliation session not found');
  return s;
}

function requireOpen(session: any): void {
  if (session.status !== 'open') {
    throw new HttpError(409, `This reconciliation is ${session.status}. Reopen it to change its items.`);
  }
}

// Signed effect of each cleared item on the session's account (same rules as balances:
// a transfer into the account counts its principal portion).
const CLEARED_DELTAS = `
  SELECT ri.id AS item_id, t.amount, t.txn_date, t.posted_date,
    CASE
      WHEN t.account_id = s.account_id THEN CASE t.direction WHEN 'income' THEN t.amount ELSE -t.amount END
      WHEN EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id AND sp.book_id = t.book_id)
        THEN COALESCE((SELECT SUM(sp.amount) FROM transaction_splits sp WHERE sp.transaction_id = t.id AND sp.book_id = t.book_id AND sp.is_principal), 0)
      ELSE COALESCE(t.principal_amount, t.amount)
    END AS delta
  FROM reconciliation_items ri
  JOIN reconciliation_sessions s ON s.id = ri.session_id
  JOIN transactions t ON t.id = ri.transaction_id AND t.book_id = ri.book_id
  WHERE ri.session_id = $1 AND ri.book_id = $2 AND ri.cleared`;

async function summarize(run: (sql: string, params: any[]) => Promise<any[]>, session: any) {
  const acct = (await run(`SELECT is_liability FROM accounts WHERE id = $1 AND book_id = $2`, [session.account_id, session.book_id]))[0];
  const mult = acct?.is_liability ? -1 : 1;
  const sum = Number((await run(`SELECT COALESCE(SUM(delta), 0) AS s FROM (${CLEARED_DELTAS}) d`, [session.id, session.book_id]))[0].s);
  const opening = Number(session.opening_balance ?? 0);
  const cleared = Math.round((opening + mult * sum) * 100) / 100;
  const statement = session.statement_balance == null ? null : Number(session.statement_balance);
  const difference = statement == null ? null : Math.round((statement - cleared) * 100) / 100;
  return { cleared_balance: cleared, difference };
}

const runQuery = (sql: string, params: any[]) => query(sql, params);

// A completed session reports its frozen figures; others report live ones.
async function withSummary(session: any) {
  if (session.status === 'completed' && session.cleared_balance != null) {
    const statement = session.statement_balance == null ? null : Number(session.statement_balance);
    return { ...session, difference: statement == null ? null : Math.round((statement - Number(session.cleared_balance)) * 100) / 100 };
  }
  return { ...session, ...(await summarize(runQuery, session)) };
}

async function logEvent(client: any, session: any, action: string, userId: number | null, detail: any = null) {
  await client.query(
    `INSERT INTO reconciliation_events (book_id, session_id, action, user_id, detail) VALUES ($1,$2,$3,$4,$5)`,
    [session.book_id, session.id, action, userId, detail]
  );
}

// Create a reconciliation session for an account in the active book. The opening
// balance defaults to the previous completed reconciliation's statement balance for
// the account, else the account's opening balance.
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
    let opening_balance = optionalMoney(req.body?.opening_balance, 'opening_balance');
    if (opening_balance == null) {
      const prev = await one<{ statement_balance: number }>(
        `SELECT statement_balance FROM reconciliation_sessions
          WHERE account_id = $1 AND book_id = $2 AND status = 'completed'
          ORDER BY statement_end DESC NULLS LAST, completed_at DESC LIMIT 1`,
        [account_id, bookId]
      );
      const acct = await one<{ opening_balance: number | null }>(`SELECT opening_balance FROM accounts WHERE id = $1 AND book_id = $2`, [account_id, bookId]);
      opening_balance = prev ? Number(prev.statement_balance) : Number(acct?.opening_balance ?? 0);
    }
    const row = await withTransaction(async (client) => {
      const s = (await client.query(
        `INSERT INTO reconciliation_sessions
           (book_id, account_id, statement_start, statement_end, statement_balance, opening_balance, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [bookId, account_id, statement_start, statement_end, statement_balance, opening_balance, req.user?.id ?? null]
      )).rows[0];
      await logEvent(client, s, 'created', req.user?.id ?? null);
      return s;
    });
    res.status(201).json(await withSummary(row));
  })
);

// List sessions, optionally filtered by account.
reconciliations.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const params: any[] = [bookId];
    let where = `book_id = $1`;
    if (req.query.account_id) { params.push(integerId(req.query.account_id, 'account_id')); where += ` AND account_id = $${params.length}`; }
    res.json(await query(`SELECT * FROM reconciliation_sessions WHERE ${where} ORDER BY started_at DESC, id DESC`, params));
  })
);

reconciliations.get(
  '/:id',
  ah(async (req, res) => {
    res.json(await withSummary(await ownedSession(req.params.id, hh(req))));
  })
);

// The session's audit trail (oldest first).
reconciliations.get(
  '/:id/events',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedSession(req.params.id, bookId);
    res.json(await query(
      `SELECT id, action, user_id, detail, created_at FROM reconciliation_events
        WHERE session_id = $1 AND book_id = $2 ORDER BY id`,
      [req.params.id, bookId]
    ));
  })
);

// Update a session's statement fields and/or status.
//   open → completed: requires a statement end date and balance and a zero difference;
//                     freezes the evidence.
//   completed → open: an explicit, audited reopen; clears the frozen figures.
//   open → canceled, canceled → open: allowed. completed → canceled: reopen first.
// A completed session's statement fields can't change.
reconciliations.put(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const status = optionalEnumValue(req.body?.status, 'status', RECON_STATUS);
    const statement_start = optionalDateOnly(req.body?.statement_start, 'statement_start');
    const statement_end = optionalDateOnly(req.body?.statement_end, 'statement_end');
    const statement_balance = optionalMoney(req.body?.statement_balance, 'statement_balance');
    const opening_balance = optionalMoney(req.body?.opening_balance, 'opening_balance');
    const userId = req.user?.id ?? null;
    const editsStatement = [statement_start, statement_end, statement_balance, opening_balance].some((v) => v != null);

    const row = await withTransaction(async (client) => {
      const cur = await ownedSession(req.params.id, bookId, client);
      if (cur.status === 'completed' && status !== 'open') {
        if (status === 'canceled') throw new HttpError(409, 'Reopen this reconciliation before canceling it.');
        if (editsStatement) throw new HttpError(409, 'This reconciliation is completed. Reopen it to change the statement.');
        return cur; // no-op (e.g. completing again)
      }

      let s = (await client.query(
        `UPDATE reconciliation_sessions SET
           statement_start = COALESCE($2, statement_start),
           statement_end = COALESCE($3, statement_end),
           statement_balance = COALESCE($4, statement_balance),
           opening_balance = COALESCE($5, opening_balance)
         WHERE id = $1 AND book_id = $6 RETURNING *`,
        [cur.id, statement_start, statement_end, statement_balance, opening_balance, bookId]
      )).rows[0];

      if (status === 'completed' && cur.status !== 'completed') {
        if (s.status !== 'open') throw new HttpError(409, `A ${s.status} reconciliation can't be completed. Reopen it first.`);
        if (s.statement_end == null || s.statement_balance == null) {
          throw new HttpError(400, 'Enter the statement end date and ending balance before completing.');
        }
        const run = async (sql: string, params: any[]) => (await client.query(sql, params)).rows;
        const { cleared_balance, difference } = await summarize(run, s);
        if (Math.abs(difference!) >= 0.005) {
          throw new HttpError(409, `The cleared balance (${cleared_balance.toFixed(2)}) doesn't match the statement balance (${Number(s.statement_balance).toFixed(2)}). Difference: ${difference!.toFixed(2)}.`);
        }
        // Freeze the evidence: each cleared item's effect and the cleared balance.
        await client.query(
          `UPDATE reconciliation_items ri SET frozen_delta = d.delta, frozen_amount = d.amount,
                  frozen_txn_date = d.txn_date, frozen_posted_date = d.posted_date
             FROM (${CLEARED_DELTAS}) d WHERE ri.id = d.item_id`,
          [s.id, bookId]
        );
        s = (await client.query(
          `UPDATE reconciliation_sessions SET status = 'completed', completed_at = now(), completed_by_user_id = $2,
                  cleared_balance = $3 WHERE id = $1 RETURNING *`,
          [s.id, userId, cleared_balance]
        )).rows[0];
        await logEvent(client, s, 'completed', userId, { cleared_balance, statement_balance: Number(s.statement_balance) });
      } else if (status === 'open' && cur.status !== 'open') {
        await client.query(
          `UPDATE reconciliation_items SET frozen_delta = NULL, frozen_amount = NULL, frozen_txn_date = NULL, frozen_posted_date = NULL
            WHERE session_id = $1 AND book_id = $2`,
          [s.id, bookId]
        );
        s = (await client.query(
          `UPDATE reconciliation_sessions SET status = 'open', completed_at = NULL, completed_by_user_id = NULL, cleared_balance = NULL
            WHERE id = $1 RETURNING *`,
          [s.id]
        )).rows[0];
        await logEvent(client, s, 'reopened', userId, { from: cur.status });
      } else if (status === 'canceled' && cur.status !== 'canceled') {
        s = (await client.query(`UPDATE reconciliation_sessions SET status = 'canceled', completed_at = NULL WHERE id = $1 RETURNING *`, [s.id])).rows[0];
        await logEvent(client, s, 'canceled', userId);
      }
      return s;
    });
    res.json(await withSummary(row));
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

// Mark a transaction cleared (or not) in an open session (idempotent on
// session+transaction). It must belong to the session's account, have posted, and
// not already be cleared in another completed reconciliation.
reconciliations.post(
  '/:id/items',
  ah(async (req, res) => {
    const bookId = hh(req);
    const transaction_id = integerId(req.body?.transaction_id, 'transaction_id');
    const cleared = optionalBoolean(req.body?.cleared, 'cleared') ?? true;
    const row = await withTransaction(async (client) => {
      const session = await ownedSession(req.params.id, bookId, client);
      requireOpen(session);
      const txn = (await client.query(
        `SELECT account_id, transfer_account_id, posted_date FROM transactions WHERE id = $1 AND book_id = $2`,
        [transaction_id, bookId]
      )).rows[0];
      if (!txn) throw new HttpError(404, 'Transaction not found in this book.');
      // The session is account-specific: only allow a transaction that posts to the
      // session's account, either directly or as the other side of a transfer.
      if (txn.account_id !== session.account_id && txn.transfer_account_id !== session.account_id) {
        throw new HttpError(400, "Transaction does not belong to this reconciliation session's account.");
      }
      if (cleared) {
        if (!txn.posted_date) throw new HttpError(400, "Only posted transactions can be cleared. This one is still pending.");
        const elsewhere = (await client.query(
          `SELECT s.id FROM reconciliation_items ri JOIN reconciliation_sessions s ON s.id = ri.session_id
            WHERE ri.transaction_id = $1 AND ri.book_id = $2 AND ri.cleared AND s.status = 'completed'
              AND s.account_id = $3 AND s.id <> $4 LIMIT 1`,
          [transaction_id, bookId, session.account_id, session.id]
        )).rows[0];
        if (elsewhere) throw new HttpError(409, 'This transaction was already cleared in another completed reconciliation for this account.');
      }
      return (await client.query(
        `INSERT INTO reconciliation_items (book_id, session_id, transaction_id, cleared)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_id, transaction_id) DO UPDATE SET cleared = EXCLUDED.cleared
         RETURNING *`,
        [bookId, session.id, transaction_id, cleared]
      )).rows[0];
    });
    res.status(201).json(row);
  })
);

reconciliations.delete(
  '/:id/items/:itemId',
  ah(async (req, res) => {
    const bookId = hh(req);
    await withTransaction(async (client) => {
      const session = await ownedSession(req.params.id, bookId, client);
      requireOpen(session);
      await client.query(`DELETE FROM reconciliation_items WHERE id = $1 AND session_id = $2 AND book_id = $3`, [req.params.itemId, session.id, bookId]);
    });
    res.status(204).end();
  })
);
