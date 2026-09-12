import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { ACCOUNT_BALANCES } from '../effectiveLines.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import { hh } from '../tenant.js';
import {
  requiredString, optionalString, enumValue, optionalEnumValue, booleanValue, optionalBoolean,
  money, optionalMoney, optionalNumber, optionalDateOnly, optionalIntegerId, ACCOUNT_TYPES,
} from '../validation.js';

export const accounts = Router();

// Shared projection for an account row with its computed posted/pending balance and
// sync/import status. Used by both the list and the single-account fetch; the caller
// supplies the WHERE/ORDER. (latest_balance is kept as an alias for the posted balance
// for backward compatibility.)
const ACCOUNT_PROJECTION = `
      SELECT a.*,
             ab.posted_balance,
             ab.pending_balance,
             ab.posted_balance AS latest_balance,
             ims.provider           AS import_provider,
             ims.last_import_at,
             ims.last_import_status,
             ims.last_import_error,
             -- Linked to an automatic-import connection (e.g. SimpleFIN)? account_links
             -- rows cascade-delete with their connection, so existence means it's live.
             EXISTS (SELECT 1 FROM account_links al WHERE al.account_id = a.id AND al.book_id = a.book_id) AS auto_synced,
             (SELECT il.provider FROM account_links al JOIN institution_links il ON il.id = al.link_id
               WHERE al.account_id = a.id AND al.book_id = a.book_id LIMIT 1) AS sync_provider,
             CASE WHEN a.closed_at IS NOT NULL AND a.closed_at <= CURRENT_DATE THEN 'closed'
                  WHEN a.archived_at IS NOT NULL THEN 'archived'
                  ELSE 'active' END AS status
      FROM accounts a
      JOIN acct_bal ab ON ab.id = a.id
      LEFT JOIN account_import_status ims ON ims.account_id = a.id`;

// List accounts, each with its computed posted & pending balance.
accounts.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    await sweepAccountClosures(bookId);
    const rows = await query(
      `WITH ${ACCOUNT_BALANCES} ${ACCOUNT_PROJECTION}
        WHERE a.book_id = $1
        ORDER BY a.sort_order, lower(a.name)`,
      [bookId]
    );
    res.json(rows);
  })
);

// One account in the same shape as the list — lets a detail page fetch just the
// account it's showing instead of pulling the whole list and filtering client-side.
accounts.get(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const row = await one(
      `WITH ${ACCOUNT_BALANCES} ${ACCOUNT_PROJECTION} WHERE a.book_id = $1 AND a.id = $2`,
      [bookId, req.params.id]
    );
    if (!row) throw new HttpError(404, 'Account not found');
    res.json(row);
  })
);

// Flip any accounts whose scheduled close date has arrived: archive them so they
// drop out of the active list. Runs lazily on list (no scheduler). Book-scoped.
async function sweepAccountClosures(bookId: number) {
  await query(
    `UPDATE accounts SET archived_at = COALESCE(archived_at, now())
     WHERE closed_at IS NOT NULL AND closed_at <= CURRENT_DATE AND archived_at IS NULL AND book_id = $1`,
    [bookId]
  );
}

// Persist a manual order (drag-to-reorder); ids are the full list in new order.
accounts.post(
  '/reorder',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    await withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(`UPDATE accounts SET sort_order = $1 WHERE id = $2 AND book_id = $3`, [i, ids[i], bookId]);
      }
    });
    res.json({ ok: true });
  })
);

// Editable account "profile" columns with per-column coercion. Shared by create
// (full insert) and update (partial — only columns present in the body are written,
// so a per-capability-tab form can save just its own fields without wiping others).
const T = (v: any) => (v == null || v === '' ? null : String(v));
// Numeric coercers route through the shared validator so a non-numeric string is a
// clean 400 ("<field> must be a number.") instead of a NaN that surfaces as a DB error.
const N = (v: any, field: string) => optionalMoney(v, field);
// Non-money numerics (rates/percentages): allow > 2 decimals (e.g. interest_rate NUMERIC(6,3)).
const NN = (v: any, field: string) => optionalNumber(v, field);
const I = (v: any, field: string) => { const n = optionalMoney(v, field); return n == null ? null : Math.trunc(n); };
const B = (v: any) => (v == null ? null : !!v);
// For NOT NULL boolean columns (the capability flags): an omitted value must
// default to false, not NULL, or the insert violates the column's NOT NULL.
const BF = (v: any) => (v == null ? false : !!v);
const D = (v: any) => (v || null);
const ACCOUNT_FIELDS: [string, (v: any, field: string) => any][] = [
  ['name', T], ['type', T], ['institution', T], ['currency', T], ['is_liability', B],
  ['account_number', T], ['interest_rate', NN], ['credit_limit', N], ['due_day', I],
  ['username', T], ['beneficiaries', T], ['opened_date', D], ['notes', T],
  ['login_url', T], ['website_url', T], ['phone', T],
  ['owner', T], ['owner_user_id', I], ['ownership_type', T],
  ['has_beneficiaries', BF], ['is_retirement', BF], ['is_card', BF], ['is_loan', BF],
  ['retirement_plan_kind', T], ['retirement_custodian', T], ['retirement_employer', T],
  ['retirement_contribution_ytd', N], ['retirement_employer_match', T], ['retirement_vesting_pct', NN],
  ['retirement_tax_treatment', T], ['retirement_rmd_applicable', B],
  ['card_statement_day', I], ['card_min_payment', N], ['card_rewards_program', T],
  ['card_points_balance', N], ['card_annual_fee', N],
  ['loan_original_principal', N], ['loan_term_months', I], ['loan_payment_amount', N],
  ['loan_payment_frequency', T], ['loan_origination_date', D], ['loan_payoff_date', D],
  ['loan_escrow_amount', N], ['loan_lien_holder', T],
];

accounts.post(
  '/',
  ah(async (req, res) => {
    const b = req.body ?? {};
    requiredString(b.name, 'name');
    b.type = b.type == null ? 'checking' : enumValue(b.type, 'type', ACCOUNT_TYPES);
    if (b.currency == null) b.currency = 'USD';
    if (b.is_liability == null) b.is_liability = false;
    const cols: string[] = []; const vals: any[] = [];
    for (const [col, coerce] of ACCOUNT_FIELDS) { cols.push(col); vals.push(coerce(b[col], col)); }
    cols.push('opening_balance'); vals.push(N(b.opening_balance, 'opening_balance') ?? 0);
    cols.push('opening_date'); vals.push(D(b.opening_date));
    cols.push('book_id'); vals.push(hh(req));
    const ph = vals.map((_, i) => `$${i + 1}`).join(',');
    const row = await one(`INSERT INTO accounts (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    res.status(201).json(row);
  })
);

accounts.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body ?? {};
    if (b.type != null) enumValue(b.type, 'type', ACCOUNT_TYPES);
    const sets: string[] = []; const vals: any[] = [];
    let i = 2; // $1 is the id
    for (const [col, coerce] of ACCOUNT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(b, col)) { sets.push(`${col} = $${i++}`); vals.push(coerce(b[col], col)); }
    }
    if ('opening_balance' in b) { sets.push(`opening_balance = $${i++}`); vals.push(N(b.opening_balance, 'opening_balance') ?? 0); }
    if ('opening_date' in b) { sets.push(`opening_date = $${i++}`); vals.push(D(b.opening_date)); }
    let row;
    if (sets.length === 0) {
      row = await one(`SELECT * FROM accounts WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    } else {
      row = await one(
        `UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 AND book_id = $${i} RETURNING *`,
        [req.params.id, ...vals, hh(req)]
      );
    }
    if (!row) throw new HttpError(404, 'Account not found');
    res.json(row);
  })
);

accounts.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const id = Number(req.params.id);
    // Deleting an account cascades to its balances / balance-events / holdings /
    // reconciliations and SET NULLs every transaction that referenced it (source
    // OR transfer leg) — irreversible money-path data loss. Refuse when the
    // account still has history; the user must archive or close it instead (both
    // preserve the data and hide the account from active views).
    const inUse = await one(
      `SELECT 1 FROM transactions WHERE (account_id = $1 OR transfer_account_id = $1) AND book_id = $2
       UNION ALL SELECT 1 FROM account_balances  WHERE account_id = $1 AND book_id = $2
       UNION ALL SELECT 1 FROM account_holdings  WHERE account_id = $1 AND book_id = $2
       LIMIT 1`,
      [id, bookId]
    );
    if (inUse) {
      throw new HttpError(409, 'This account has transactions or balance history. Archive or close it instead of deleting.');
    }
    const row = await one(`DELETE FROM accounts WHERE id = $1 AND book_id = $2 RETURNING id`, [id, bookId]);
    if (!row) throw new HttpError(404, 'Account not found');
    res.status(204).end();
  })
);

// Confirm an account belongs to the active book, or 404.
async function ownedAccount(req: any): Promise<number> {
  const acct = await one<{ id: number }>(`SELECT id FROM accounts WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!acct) throw new HttpError(404, 'Account not found');
  return acct.id;
}

// --- Daily balances for an account ---
accounts.get(
  '/:id/balances',
  ah(async (req, res) => {
    await ownedAccount(req);
    const rows = await query(
      `SELECT ab.*,
              -- A balance auto-recorded from a SimpleFIN import leaves a 'simplefin'
              -- snapshot event for the same date; flag those so the UI can mark them.
              EXISTS (SELECT 1 FROM account_balance_events e
                       WHERE e.account_id = ab.account_id AND e.as_of = ab.as_of
                         AND e.source = 'simplefin' AND e.event_type = 'snapshot' AND e.voided_at IS NULL) AS auto_imported
         FROM account_balances ab WHERE ab.account_id = $1 AND ab.book_id = $2 ORDER BY ab.as_of`,
      [req.params.id, hh(req)]
    );
    res.json(rows);
  })
);

// Investment holdings/composition for an account (latest snapshot, from a linked
// provider). Empty for accounts that don't report positions.
accounts.get(
  '/:id/holdings',
  ah(async (req, res) => {
    await ownedAccount(req);
    const rows = await query(
      `SELECT id, symbol, description, shares::float8 AS shares, market_value::float8 AS market_value,
              cost_basis::float8 AS cost_basis, currency, to_char(as_of,'YYYY-MM-DD') AS as_of
         FROM account_holdings WHERE account_id = $1 AND book_id = $2
        ORDER BY market_value DESC NULLS LAST, symbol`,
      [req.params.id, hh(req)]
    );
    res.json(rows);
  })
);

// Record (or overwrite) a daily balance snapshot. The snapshot behaviour is
// unchanged; we additionally append a (never-updated) balance_adjustments audit
// row capturing the previous → new balance for this date.
accounts.post(
  '/:id/balances',
  ah(async (req, res) => {
    const balance = money(req.body?.balance, 'balance');
    const as_of = optionalDateOnly(req.body?.as_of, 'as_of');
    const reason = optionalString(req.body?.reason, 'reason');
    const bookId = hh(req);
    const accountId = await ownedAccount(req);
    const row = await withTransaction(async (client) => {
      // Serialize concurrent snapshots for this account so two same-date posts can't
      // both read the same `prev` and write conflicting previous_balance audit rows.
      await client.query(`SELECT 1 FROM accounts WHERE id = $1 AND book_id = $2 FOR UPDATE`, [accountId, bookId]);
      const prev = (await client.query(
        `SELECT balance FROM account_balances WHERE account_id = $1 AND as_of = COALESCE($2::date, CURRENT_DATE) AND book_id = $3`,
        [accountId, as_of, bookId]
      )).rows[0];
      const r = (await client.query(
        `INSERT INTO account_balances (account_id, balance, as_of, book_id)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4)
         ON CONFLICT (account_id, as_of)
         DO UPDATE SET balance = EXCLUDED.balance
         RETURNING *`,
        [accountId, balance, as_of, bookId]
      )).rows[0];
      await client.query(
        `INSERT INTO balance_adjustments (book_id, account_id, adjustment_date, previous_balance, new_balance, reason, source, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,'snapshot',$7)`,
        [bookId, accountId, r.as_of, prev?.balance ?? null, balance, reason, req.user?.id ?? null]
      );
      // Record a dated balance fact in the net-worth ledger.
      await client.query(
        `INSERT INTO account_balance_events (book_id, account_id, as_of, balance, event_type, source, created_by_user_id)
         VALUES ($1,$2,$3,$4,'snapshot','manual',$5)`,
        [bookId, accountId, r.as_of, balance, req.user?.id ?? null]
      );
      return r;
    });
    res.status(201).json(row);
  })
);

// The account's dated balance events (the net-worth ledger for this account).
accounts.get(
  '/:id/balance-events',
  ah(async (req, res) => {
    await ownedAccount(req);
    const rows = await query(
      `SELECT * FROM account_balance_events WHERE account_id = $1 AND book_id = $2 AND voided_at IS NULL ORDER BY as_of DESC, id DESC`,
      [req.params.id, hh(req)]
    );
    res.json(rows);
  })
);

// Append-only balance-adjustment audit history for an account (newest first).
accounts.get(
  '/:id/adjustments',
  ah(async (req, res) => {
    await ownedAccount(req);
    const rows = await query(
      `SELECT * FROM balance_adjustments WHERE account_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.params.id, hh(req)]
    );
    res.json(rows);
  })
);

// Archive / unarchive an account. Archived accounts are hidden from the default
// account list but keep every transaction and balance — nothing is deleted.
accounts.post(
  '/:id/archive',
  ah(async (req, res) => {
    const archived = booleanValue(req.body?.archived, 'archived', { default: true });
    const row = await one(
      `UPDATE accounts SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END
       WHERE id = $1 AND book_id = $3 RETURNING *`,
      [req.params.id, archived, hh(req)]
    );
    if (!row) throw new HttpError(404, 'Account not found');
    res.json(row);
  })
);

// Close / reopen an account. A future close date schedules the closure (the
// account stays active until the date, then the lazy sweep archives it, mirroring
// the utility/subscription cancel flow). An immediate (today/past) date archives
// now. Reopening clears both closed_at and archived_at.
accounts.post(
  '/:id/close',
  ah(async (req, res) => {
    const closed = booleanValue(req.body?.closed, 'closed', { default: true });
    const closed_at = optionalDateOnly(req.body?.closed_at, 'closed_at');
    const close_reason = optionalString(req.body?.close_reason, 'close_reason');
    const row = await one(
      `UPDATE accounts SET
         closed_at    = CASE WHEN $2 THEN COALESCE($3::date, CURRENT_DATE) ELSE NULL END,
         close_reason = CASE WHEN $2 THEN $4 ELSE NULL END,
         archived_at  = CASE WHEN $2 AND COALESCE($3::date, CURRENT_DATE) <= CURRENT_DATE
                              THEN COALESCE(archived_at, now())
                             WHEN $2 THEN archived_at
                             ELSE NULL END
       WHERE id = $1 AND book_id = $5 RETURNING *`,
      [req.params.id, closed, closed_at, close_reason, hh(req)]
    );
    if (!row) throw new HttpError(404, 'Account not found');
    res.json(row);
  })
);

// Delete a balance snapshot. Deleting the snapshot must also stop the net-worth
// ledger from counting it: we void (not delete) the matching snapshot event so the
// ledger stays append-only and net-worth history ignores the removed fact. The
// balance_adjustments audit trail is left fully intact (append-only).
accounts.delete(
  '/:id/balances/:balanceId',
  ah(async (req, res) => {
    const bookId = hh(req);
    await withTransaction(async (client) => {
      const deleted = (await client.query(
        `DELETE FROM account_balances WHERE id = $1 AND account_id = $2 AND book_id = $3 RETURNING as_of`,
        [req.params.balanceId, req.params.id, bookId]
      )).rows[0];
      if (deleted) {
        await client.query(
          `UPDATE account_balance_events SET voided_at = now()
           WHERE account_id = $1 AND book_id = $2 AND as_of = $3
             AND event_type = 'snapshot' AND voided_at IS NULL`,
          [req.params.id, bookId, deleted.as_of]
        );
      }
    });
    res.status(204).end();
  })
);

// --- Documents attached to an account (statements, tax forms, agreements, …) ---
accounts.get(
  '/:id/documents',
  ah(async (req, res) => {
    await ownedAccount(req);
    res.json(await query(
      `SELECT id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM account_documents WHERE account_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

accounts.post(
  '/:id/documents',
  ah(async (req, res) => {
    require_(req.body, ['file']);
    const bookId = hh(req);
    await ownedAccount(req);
    const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
    if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
    const safeMime = assertUploadMime(file_mime);
    assertUploadSize(file);
    const buf = Buffer.from(file, 'base64');
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const row = await one(
      `INSERT INTO account_documents (account_id, book_id, doc_type, name, file, file_mime, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
      [req.params.id, bookId, docType, name || file_name, buf, safeMime, file_name]
    );
    res.status(201).json(row);
  })
);

// Update a document's metadata (name + type), optionally replacing the stored file.
accounts.put(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await ownedAccount(req);
    const { name = null, doc_type = null, file = null, file_mime = null, file_name = null } = req.body ?? {};
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const returning = `RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`;
    let row;
    if (file != null) {
      if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
      const safeMime = assertUploadMime(file_mime);
      assertUploadSize(file);
      const buf = Buffer.from(file, 'base64');
      row = await one(
        `UPDATE account_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
         WHERE id = $6 AND account_id = $7 AND book_id = $8 ${returning}`,
        [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
      );
    } else {
      row = await one(
        `UPDATE account_documents SET name = $1, doc_type = $2
         WHERE id = $3 AND account_id = $4 AND book_id = $5 ${returning}`,
        [name, docType, req.params.docId, req.params.id, hh(req)]
      );
    }
    if (!row) throw new HttpError(404, 'Document not found.');
    res.json(row);
  })
);

accounts.get(
  '/:id/documents/:docId/file',
  ah(async (req, res) => {
    await ownedAccount(req);
    const r = await one<any>(
      `SELECT file, file_mime, file_name FROM account_documents WHERE id = $1 AND account_id = $2 AND book_id = $3`,
      [req.params.docId, req.params.id, hh(req)]
    );
    if (!r || !r.file) throw new HttpError(404, 'Document not found.');
    sendStoredFile(res, r.file, r.file_mime, r.file_name);
  })
);

accounts.delete(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await query(`DELETE FROM account_documents WHERE id = $1 AND account_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// --- Beneficiaries for an account (structured; used by the Beneficiaries tab) ---
const BENEF_COLS = `id, name, relationship, kind, percentage, notes, sort_order`;
const benefT = (v: any) => (v == null || v === '' ? null : String(v));
const benefN = (v: any) => (v == null || v === '' ? null : Number(v));

accounts.get(
  '/:id/beneficiaries',
  ah(async (req, res) => {
    await ownedAccount(req);
    res.json(await query(
      `SELECT ${BENEF_COLS} FROM account_beneficiaries
       WHERE account_id = $1 AND book_id = $2 ORDER BY kind, sort_order, id`,
      [req.params.id, hh(req)]
    ));
  })
);

accounts.post(
  '/:id/beneficiaries',
  ah(async (req, res) => {
    const accountId = await ownedAccount(req);
    const b = req.body ?? {};
    const name = requiredString(b.name, 'name');
    const row = await one(
      `INSERT INTO account_beneficiaries (account_id, book_id, name, relationship, kind, percentage, notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0)) RETURNING ${BENEF_COLS}`,
      [accountId, hh(req), name, benefT(b.relationship), b.kind === 'contingent' ? 'contingent' : 'primary', benefN(b.percentage), benefT(b.notes), benefN(b.sort_order)]
    );
    res.status(201).json(row);
  })
);

accounts.put(
  '/:id/beneficiaries/:bid',
  ah(async (req, res) => {
    await ownedAccount(req);
    const b = req.body ?? {};
    const row = await one(
      `UPDATE account_beneficiaries SET name = $1, relationship = $2, kind = $3, percentage = $4, notes = $5
       WHERE id = $6 AND account_id = $7 AND book_id = $8 RETURNING ${BENEF_COLS}`,
      [benefT(b.name) ?? '', benefT(b.relationship), b.kind === 'contingent' ? 'contingent' : 'primary', benefN(b.percentage), benefT(b.notes), req.params.bid, req.params.id, hh(req)]
    );
    if (!row) throw new HttpError(404, 'Beneficiary not found');
    res.json(row);
  })
);

accounts.delete(
  '/:id/beneficiaries/:bid',
  ah(async (req, res) => {
    await query(`DELETE FROM account_beneficiaries WHERE id = $1 AND account_id = $2 AND book_id = $3`, [req.params.bid, req.params.id, hh(req)]);
    res.status(204).end();
  })
);
