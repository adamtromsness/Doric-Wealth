import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import { requiredString, optionalEnumValue, optionalMoney, optionalNumber, optionalDateOnly, optionalIntegerId } from '../validation.js';

// Value-field validation shared by create/update (throws a clean 400 on bad input).
function validateLiability(b: any): void {
  optionalEnumValue(b.liability_type, 'liability_type', LIABILITY_TYPES);
  optionalMoney(b.balance, 'balance');
  optionalMoney(b.original_amount, 'original_amount');
  optionalNumber(b.interest_rate, 'interest_rate'); // NUMERIC(6,3): rate, not money — allows 3 decimals
  optionalMoney(b.minimum_payment, 'minimum_payment');
  optionalIntegerId(b.due_day, 'due_day');
  optionalDateOnly(b.opened_date, 'opened_date');
  optionalDateOnly(b.payoff_date, 'payoff_date');
}

export const liabilities = Router();

export const LIABILITY_TYPES = [
  'mortgage', 'auto_loan', 'student_loan', 'personal_loan', 'credit_card', 'medical', 'other',
] as const;

const bool = (v: any) => (v == null ? null : !!v);
const str = (v: any) => (v == null || v === '' ? null : String(v));

// Confirm a liability belongs to the active book, or 404.
async function ownedLiability(req: any): Promise<number> {
  const l = await one<{ id: number }>(`SELECT id FROM liabilities WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!l) throw new HttpError(404, 'Liability not found');
  return l.id;
}

liabilities.get(
  '/',
  ah(async (req, res) => {
    res.json(await query(`SELECT * FROM liabilities WHERE book_id = $1 ORDER BY liability_type, name`, [hh(req)]));
  })
);

liabilities.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const b = req.body;
    requiredString(b.name, 'name');
    validateLiability(b);
    const row = await one(
      `INSERT INTO liabilities
        (name, liability_type, balance, original_amount, interest_rate, notes,
         lender, account_number, due_day, minimum_payment, opened_date, payoff_date,
         tracks_balance, has_documents, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [b.name, b.liability_type ?? 'mortgage', b.balance ?? null, b.original_amount ?? null, b.interest_rate ?? null, b.notes ?? null,
       str(b.lender), str(b.account_number), b.due_day ?? null, b.minimum_payment ?? null, b.opened_date ?? null, b.payoff_date ?? null,
       bool(b.tracks_balance) ?? false, bool(b.has_documents) ?? false, hh(req)]
    );
    res.status(201).json(row);
  })
);

liabilities.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body;
    validateLiability(b);
    const row = await one(
      `UPDATE liabilities SET
         name = COALESCE($2, name), liability_type = COALESCE($3, liability_type),
         balance = $4, original_amount = $5, interest_rate = $6, notes = $7,
         lender = $8, account_number = $9, due_day = $10, minimum_payment = $11, opened_date = $12, payoff_date = $13,
         tracks_balance = COALESCE($14, tracks_balance), has_documents = COALESCE($15, has_documents)
       WHERE id = $1 AND book_id = $16 RETURNING *`,
      [req.params.id, b.name ?? null, b.liability_type ?? null, b.balance ?? null, b.original_amount ?? null, b.interest_rate ?? null, b.notes ?? null,
       str(b.lender), str(b.account_number), b.due_day ?? null, b.minimum_payment ?? null, b.opened_date ?? null, b.payoff_date ?? null,
       bool(b.tracks_balance), bool(b.has_documents), hh(req)]
    );
    if (!row) throw new HttpError(404, 'Liability not found');
    res.json(row);
  })
);

liabilities.delete(
  '/:id',
  ah(async (req, res) => {
    await query(`DELETE FROM liabilities WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// --- Balance-owed snapshots (latest drives the current balance) --------------
liabilities.get('/:id/balances', ah(async (req, res) => {
  await ownedLiability(req);
  res.json(await query(
    `SELECT id, to_char(as_of,'YYYY-MM-DD') AS as_of, balance AS value FROM liability_balances
     WHERE liability_id = $1 AND book_id = $2 ORDER BY as_of`,
    [req.params.id, hh(req)]
  ));
}));

liabilities.post('/:id/balances', ah(async (req, res) => {
  const liabilityId = await ownedLiability(req);
  const value = optionalMoney(req.body?.value, 'value');
  if (value == null) throw new HttpError(400, 'value is required.');
  const as_of = optionalDateOnly(req.body?.as_of, 'as_of');
  await one(
    `INSERT INTO liability_balances (liability_id, book_id, as_of, balance)
     VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4)
     ON CONFLICT (liability_id, as_of) DO UPDATE SET balance = EXCLUDED.balance RETURNING id`,
    [liabilityId, hh(req), as_of, value]
  );
  await query(
    `UPDATE liabilities SET balance = (SELECT balance FROM liability_balances WHERE liability_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1)
     WHERE id = $1 AND book_id = $2`,
    [liabilityId, hh(req)]
  );
  res.status(201).json({ ok: true });
}));

liabilities.delete('/:id/balances/:bid', ah(async (req, res) => {
  const liabilityId = await ownedLiability(req);
  await query(`DELETE FROM liability_balances WHERE id = $1 AND liability_id = $2 AND book_id = $3`, [req.params.bid, liabilityId, hh(req)]);
  await query(
    `UPDATE liabilities SET balance = (SELECT balance FROM liability_balances WHERE liability_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1)
     WHERE id = $1 AND book_id = $2`,
    [liabilityId, hh(req)]
  );
  res.status(204).end();
}));

// --- Documents ---------------------------------------------------------------
liabilities.get('/:id/documents', ah(async (req, res) => {
  await ownedLiability(req);
  res.json(await query(
    `SELECT id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
     FROM liability_documents WHERE liability_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
    [req.params.id, hh(req)]
  ));
}));

liabilities.post('/:id/documents', ah(async (req, res) => {
  require_(req.body, ['file']);
  const liabilityId = await ownedLiability(req);
  const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
  if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
  const safeMime = assertUploadMime(file_mime);
  assertUploadSize(file);
  const buf = Buffer.from(file, 'base64');
  const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
  const row = await one(
    `INSERT INTO liability_documents (liability_id, book_id, doc_type, name, file, file_mime, file_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
    [liabilityId, hh(req), docType, name || file_name, buf, safeMime, file_name]
  );
  res.status(201).json(row);
}));

liabilities.put('/:id/documents/:docId', ah(async (req, res) => {
  await ownedLiability(req);
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
      `UPDATE liability_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
       WHERE id = $6 AND liability_id = $7 AND book_id = $8 ${returning}`,
      [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
    );
  } else {
    row = await one(
      `UPDATE liability_documents SET name = $1, doc_type = $2
       WHERE id = $3 AND liability_id = $4 AND book_id = $5 ${returning}`,
      [name, docType, req.params.docId, req.params.id, hh(req)]
    );
  }
  if (!row) throw new HttpError(404, 'Document not found.');
  res.json(row);
}));

liabilities.get('/:id/documents/:docId/file', ah(async (req, res) => {
  await ownedLiability(req);
  const r = await one<any>(
    `SELECT file, file_mime, file_name FROM liability_documents WHERE id = $1 AND liability_id = $2 AND book_id = $3`,
    [req.params.docId, req.params.id, hh(req)]
  );
  if (!r || !r.file) throw new HttpError(404, 'Document not found.');
  sendStoredFile(res, r.file, r.file_mime, r.file_name);
}));

liabilities.delete('/:id/documents/:docId', ah(async (req, res) => {
  await query(`DELETE FROM liability_documents WHERE id = $1 AND liability_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
  res.status(204).end();
}));
