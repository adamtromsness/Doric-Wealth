import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import {
  requiredString, optionalEnumValue, optionalDateOnly, money, optionalMoney, optionalNumber, booleanValue,
  optionalIntegerId, ownedRef, clampText, UTILITY_TYPES, UTILITY_BILLING_CYCLES, CHANNELS,
} from '../validation.js';
import { hh } from '../tenant.js';
import { syncManagedCategoriesSafe } from '../managedCategories.js';
import { askVision, AiNotConfiguredError } from '../ai/claude.js';
import { extractPdfText, parseInvoiceText } from '../invoiceScan.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';

export const utilities = Router();

const PAYMENT_PLANS = ['actual', 'average'] as const;
const todayISO = () => new Date().toISOString().slice(0, 10);

// Confirm a utility account belongs to the active book, or 404.
async function ownedUtilityAccount(req: any): Promise<number> {
  const a = await one<{ id: number }>(`SELECT id FROM utility_accounts WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!a) throw new HttpError(404, 'Utility account not found');
  return a.id;
}

// Flip any utility accounts whose scheduled cancellation date has arrived. Runs
// lazily when accounts are listed (there's no scheduler). Book-scoped.
async function sweepUtilityCancellations(bookId: number) {
  await query(
    `UPDATE utility_accounts SET status = 'canceled'
     WHERE status <> 'canceled' AND end_date IS NOT NULL AND end_date <= CURRENT_DATE AND book_id = $1`,
    [bookId]
  );
}

// ---------------------------------------------------------------------------
// Utility accounts (a tracked service: electricity, water, trash, ...)
// ---------------------------------------------------------------------------
utilities.get(
  '/accounts',
  ah(async (req, res) => {
    await sweepUtilityCancellations(hh(req));
    res.json(await query(`
      SELECT ua.*, p.name AS property_name, pa.name AS payment_account_name,
             COALESCE(agg.total_billed, 0)  AS total_billed,
             COALESCE(agg.invoice_count, 0) AS invoice_count,
             COALESCE(agg.unpaid_amount, 0) AS unpaid_amount,
             COALESCE(agg.unpaid_count, 0)  AS unpaid_count
      FROM utility_accounts ua
      LEFT JOIN properties p ON p.id = ua.property_id
      LEFT JOIN accounts pa ON pa.id = ua.payment_account_id
      LEFT JOIN (
        SELECT x.utility_account_id,
               SUM(x.acct_lines) AS total_billed,
               COUNT(*) AS invoice_count,
               SUM(CASE WHEN NOT x.paid
                        THEN GREATEST(x.acct_lines - x.inv_paid * (x.acct_lines / NULLIF(x.inv_total, 0)), 0)
                        ELSE 0 END) AS unpaid_amount,
               COUNT(*) FILTER (WHERE NOT x.paid) AS unpaid_count
        FROM (
          SELECT l.utility_account_id, l.invoice_id, i.paid,
                 SUM(l.amount) AS acct_lines,
                 it.total AS inv_total,
                 COALESCE(p.paid_amt, 0) AS inv_paid
          FROM utility_invoice_lines l
          JOIN utility_invoices i ON i.id = l.invoice_id
          JOIN (SELECT invoice_id, SUM(amount) AS total FROM utility_invoice_lines GROUP BY invoice_id) it ON it.invoice_id = l.invoice_id
          LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid_amt FROM utility_invoice_payments GROUP BY invoice_id) p ON p.invoice_id = l.invoice_id
          GROUP BY l.utility_account_id, l.invoice_id, i.paid, it.total, p.paid_amt
        ) x
        GROUP BY x.utility_account_id
      ) agg ON agg.utility_account_id = ua.id
      WHERE ua.book_id = $1
      ORDER BY ua.sort_order, lower(ua.name)
    `, [hh(req)]));
  })
);

// Persist a manual order (drag-to-reorder); ids are the full list in new order.
utilities.post(
  '/accounts/reorder',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    await withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(`UPDATE utility_accounts SET sort_order = $1 WHERE id = $2 AND book_id = $3`, [i, ids[i], bookId]);
      }
    });
    res.json({ ok: true });
  })
);

utilities.post(
  '/accounts',
  ah(async (req, res) => {
    const bookId = hh(req);
    const b = req.body ?? {};
    const name = requiredString(b.name, 'name');
    const utility_type = optionalEnumValue(b.utility_type, 'utility_type', UTILITY_TYPES) ?? 'electricity';
    const billing_cycle = optionalEnumValue(b.billing_cycle, 'billing_cycle', UTILITY_BILLING_CYCLES) ?? 'monthly';
    const due_day = optionalIntegerId(b.due_day, 'due_day');
    const autopay_day = optionalIntegerId(b.autopay_day, 'autopay_day');
    const property_id = await ownedRef('property', b.property_id, bookId, 'property_id');
    const payment_account_id = await ownedRef('account', b.payment_account_id, bookId, 'payment_account_id');
    const payment_plan = optionalEnumValue(b.payment_plan, 'payment_plan', PAYMENT_PLANS) ?? 'actual';
    const row = await one(
      `INSERT INTO utility_accounts (name, provider, utility_type, account_number, property_id, due_day, usage_unit, notes, billing_cycle, login_url, login_id,
         is_autopay, payment_method, meter_number, provider_phone, account_holder, rate_plan,
         provider_url, autopay_day, payment_account_id, payment_plan, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [name, b.provider ?? null, utility_type, b.account_number ?? null,
       property_id, due_day, b.usage_unit ?? null, b.notes ?? null, billing_cycle, b.login_url ?? null, b.login_id ?? null,
       b.is_autopay ?? false, b.payment_method ?? null, b.meter_number ?? null, b.provider_phone ?? null, b.account_holder ?? null, b.rate_plan ?? null,
       b.provider_url ?? null, autopay_day, payment_account_id, payment_plan, bookId]
    );
    syncManagedCategoriesSafe(bookId);
    res.status(201).json(row);
  })
);

utilities.put(
  '/accounts/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const b = req.body ?? {};
    const utility_type = optionalEnumValue(b.utility_type, 'utility_type', UTILITY_TYPES);
    const billing_cycle = optionalEnumValue(b.billing_cycle, 'billing_cycle', UTILITY_BILLING_CYCLES);
    const due_day = optionalIntegerId(b.due_day, 'due_day');
    const autopay_day = optionalIntegerId(b.autopay_day, 'autopay_day');
    const property_id = await ownedRef('property', b.property_id, bookId, 'property_id');
    const payment_account_id = await ownedRef('account', b.payment_account_id, bookId, 'payment_account_id');
    const payment_plan = optionalEnumValue(b.payment_plan, 'payment_plan', PAYMENT_PLANS);
    // Status & end_date are owned by the cancel/reactivate actions, not this edit.
    const row = await one(
      `UPDATE utility_accounts SET
         name = COALESCE($2, name), provider = $3, utility_type = COALESCE($4, utility_type),
         account_number = $5, property_id = $6, due_day = $7, usage_unit = $8, notes = $9,
         billing_cycle = COALESCE($10, billing_cycle), login_url = $12, login_id = $13,
         is_autopay = COALESCE($14, is_autopay), payment_method = $15, meter_number = $16,
         provider_phone = $17, account_holder = $18, rate_plan = $19,
         provider_url = $20, autopay_day = $21, payment_account_id = $22, payment_plan = COALESCE($23, payment_plan)
       WHERE id = $1 AND book_id = $11 RETURNING *`,
      [req.params.id, b.name ?? null, b.provider ?? null, utility_type,
       b.account_number ?? null, property_id, due_day, b.usage_unit ?? null, b.notes ?? null, billing_cycle, bookId,
       b.login_url ?? null, b.login_id ?? null,
       b.is_autopay ?? null, b.payment_method ?? null, b.meter_number ?? null, b.provider_phone ?? null, b.account_holder ?? null, b.rate_plan ?? null,
       b.provider_url ?? null, autopay_day, payment_account_id, payment_plan]
    );
    if (!row) throw new HttpError(404, 'Utility account not found');
    syncManagedCategoriesSafe(bookId);
    res.json(row);
  })
);

// Cancel / disable a utility account effective `date` (defaults to today). A future
// date schedules it — the account stays active until then, when the sweep flips it.
utilities.post(
  '/accounts/:id/cancel',
  ah(async (req, res) => {
    const bookId = hh(req);
    const date = optionalDateOnly(req.body?.date, 'date') || todayISO();
    const immediate = date <= todayISO();
    const row = await one(
      immediate
        ? `UPDATE utility_accounts SET status = 'canceled', end_date = $2 WHERE id = $1 AND book_id = $3 RETURNING *`
        : `UPDATE utility_accounts SET end_date = $2 WHERE id = $1 AND book_id = $3 RETURNING *`,
      [req.params.id, date, bookId]
    );
    if (!row) throw new HttpError(404, 'Utility account not found');
    res.json(row);
  })
);

// Reactivate a canceled account, or clear a pending future cancellation.
utilities.post(
  '/accounts/:id/reactivate',
  ah(async (req, res) => {
    const bookId = hh(req);
    const row = await one(
      `UPDATE utility_accounts SET status = 'active', end_date = NULL WHERE id = $1 AND book_id = $2 RETURNING *`,
      [req.params.id, bookId]
    );
    if (!row) throw new HttpError(404, 'Utility account not found');
    res.json(row);
  })
);

utilities.delete(
  '/accounts/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    await query(`DELETE FROM utility_accounts WHERE id = $1 AND book_id = $2`, [req.params.id, bookId]);
    syncManagedCategoriesSafe(bookId);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Invoices (a received bill) + their per-utility lines
// ---------------------------------------------------------------------------
utilities.get(
  '/invoices',
  ah(async (req, res) => {
    const params: any[] = [hh(req)];
    const where: string[] = [`i.book_id = $1`];
    if (req.query.account_id) {
      params.push(req.query.account_id);
      where.push(`i.id IN (SELECT invoice_id FROM utility_invoice_lines WHERE utility_account_id = $${params.length})`);
    }
    if (req.query.unpaid === 'true') where.push(`i.paid = FALSE`);
    const whereSql = 'WHERE ' + where.join(' AND ');
    // The book-wide list is capped, but a single account's invoices are bounded by
    // nature (one bill per period), so when scoped to an account we return them ALL —
    // the detail page derives all-time billing stats from this set and must not see a
    // truncated list (which would disagree with the account's SQL total_billed/count).
    const limitSql = req.query.account_id ? '' : 'LIMIT 500';

    const invoices = await query(
      // Explicit columns so the (potentially large) file blob isn't shipped in the list.
      `SELECT i.id, i.provider, i.invoice_date, i.period_start, i.period_end, i.due_date,
              i.paid, i.paid_date, i.transaction_id, i.notes, i.category_id, i.account_id, i.channel, i.late_total,
              i.file_mime, i.file_name, (i.file IS NOT NULL) AS has_file,
              c.name AS category_name, a.name AS account_name
       FROM utility_invoices i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN accounts a ON a.id = i.account_id
       ${whereSql}
       ORDER BY i.paid, i.due_date DESC NULLS LAST, i.id DESC ${limitSql}`,
      params
    );
    const ids = invoices.map((i: any) => i.id);
    const lines = ids.length
      ? await query(
          `SELECT l.*, ua.name AS account_name, ua.utility_type
           FROM utility_invoice_lines l
           LEFT JOIN utility_accounts ua ON ua.id = l.utility_account_id
           WHERE l.invoice_id = ANY($1) ORDER BY l.id`,
          [ids]
        )
      : [];
    const byInvoice = new Map<number, any[]>();
    for (const l of lines as any[]) {
      if (!byInvoice.has(l.invoice_id)) byInvoice.set(l.invoice_id, []);
      byInvoice.get(l.invoice_id)!.push(l);
    }
    const paid = ids.length
      ? await query(`SELECT invoice_id, SUM(amount) AS amt FROM utility_invoice_payments WHERE invoice_id = ANY($1) GROUP BY invoice_id`, [ids])
      : [];
    const paidByInvoice = new Map<number, number>((paid as any[]).map((p) => [p.invoice_id, Number(p.amt)]));
    res.json(invoices.map((i: any) => {
      const ls = byInvoice.get(i.id) ?? [];
      return { ...i, lines: ls, total: Math.round(ls.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100, amount_paid: paidByInvoice.get(i.id) ?? 0 };
    }));
  })
);

// Stream the stored original invoice file for review.
utilities.get(
  '/invoices/:id/file',
  ah(async (req, res) => {
    const r = await one<any>(`SELECT file, file_mime, file_name FROM utility_invoices WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    if (!r || !r.file) throw new HttpError(404, 'No file on this invoice.');
    sendStoredFile(res, r.file, r.file_mime, r.file_name);
  })
);

// Extract invoice fields from an uploaded bill (image or PDF) via AI vision.
// Stateless — the file is held client-side until the invoice is saved.
const INVOICE_PROMPT = `This is a utility bill / invoice (image or PDF). Extract its details as JSON with exactly this shape:
{
  "provider": string | null,
  "invoice_date": "YYYY-MM-DD" | null,
  "due_date": "YYYY-MM-DD" | null,
  "period_start": "YYYY-MM-DD" | null,
  "period_end": "YYYY-MM-DD" | null,
  "total": number | null,
  "lines": [{ "description": string, "amount": number }]
}
Rules: provider is the company/biller name. Dates as YYYY-MM-DD. Numbers plain (no currency symbols). "lines" are itemized charges if the bill breaks them out (e.g. "Energy charge", "Delivery", "Taxes"); otherwise return an empty array. If a field is unreadable use null. Return ONLY the JSON object — no prose, no code fences.`;

function parseInvoiceJson(text: string): any {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// Heuristic scan (no AI required): extract text from a PDF bill and regex out
// the common fields. Images need OCR, so they fall back to the AI scan.
utilities.post(
  '/invoices/parse-basic',
  ah(async (req, res) => {
    const { file, mime } = req.body ?? {};
    if (!file) throw new HttpError(400, 'No file provided.');
    if (mime && !String(mime).includes('pdf')) {
      throw new HttpError(415, 'Basic scan reads PDF bills. For an image, use “Scan with AI”.');
    }
    // Decode and validate the bytes BEFORE handing them to pdf-parse: bound the
    // size (the parser loads the whole document into memory synchronously) and
    // require the %PDF- magic header so a mislabeled or hostile blob can't reach
    // the parser's CVE surface as a content-type bypass.
    const buf = Buffer.from(String(file), 'base64');
    const MAX_PDF_BYTES = 15 * 1024 * 1024;
    if (buf.length > MAX_PDF_BYTES) throw new HttpError(413, 'That PDF is too large to scan. Enter the details manually.');
    if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpError(415, 'That file is not a readable PDF. For an image, use “Scan with AI”.');
    }
    let text: string;
    try { text = await extractPdfText(buf); }
    catch { throw new HttpError(422, 'Could not read text from this PDF (it may be a scanned image). Try “Scan with AI” or enter the details manually.'); }
    if (!text.trim()) throw new HttpError(422, 'No readable text in this PDF (it may be a scanned image). Try “Scan with AI” or enter manually.');
    const parsed = parseInvoiceText(text);
    // Match the bill text against a known utility account (this book) to fill provider + line.
    const accts = await query<any>(`SELECT id, name, provider FROM utility_accounts WHERE book_id = $1`, [hh(req)]);
    const lc = text.toLowerCase();
    const matched = accts.find((a: any) =>
      (a.name && lc.includes(String(a.name).toLowerCase())) ||
      (a.provider && lc.includes(String(a.provider).toLowerCase()))
    );
    res.json({
      ...parsed,
      provider: (matched && (matched.provider || matched.name)) || parsed.provider || null,
      account_id: matched?.id ?? null,
      account_name: matched?.name ?? null,
    });
  })
);

utilities.post(
  '/invoices/parse',
  ah(async (req, res) => {
    const { file, mime } = req.body ?? {};
    if (!file) throw new HttpError(400, 'No file provided.');
    try {
      const text = await askVision([{ data: file, mime: mime || 'application/pdf' }], INVOICE_PROMPT);
      let parsed: any;
      try { parsed = parseInvoiceJson(text); }
      catch { throw new HttpError(502, 'Could not read the invoice — the AI response was not valid JSON. You can enter the details manually.'); }
      res.json(parsed);
    } catch (e) {
      if (e instanceof AiNotConfiguredError) throw new HttpError(503, e.message);
      throw e;
    }
  })
);

// Insert/replace an invoice with its lines, atomically. All rows are tenanted.
async function saveInvoice(client: any, id: number | null, b: any, bookId: number) {
  // Validate the header value fields and cross-book references up front.
  optionalDateOnly(b.invoice_date, 'invoice_date');
  optionalDateOnly(b.period_start, 'period_start');
  optionalDateOnly(b.period_end, 'period_end');
  optionalDateOnly(b.due_date, 'due_date');
  optionalDateOnly(b.paid_date, 'paid_date');
  optionalEnumValue(b.channel, 'channel', CHANNELS);
  optionalMoney(b.late_total, 'late_total');
  if (b.paid != null) booleanValue(b.paid, 'paid');
  const account_id = await ownedRef('account', b.account_id, bookId, 'account_id');
  const category_id = await ownedRef('category', b.category_id, bookId, 'category_id');
  // Bound free-text fields (may originate from an AI scan or a crafted client).
  const fields = [clampText(b.provider, 200), b.invoice_date ?? null, b.period_start ?? null,
                  b.period_end ?? null, b.due_date ?? null, b.paid ?? false, b.paid_date ?? null,
                  clampText(b.notes, 2000), category_id, account_id, b.channel ?? null,
                  b.late_total ?? null];
  const fileBuf = b.file ? Buffer.from(b.file, 'base64') : null;
  // Validate the MIME of any newly-uploaded bill before storing it — it's served
  // back inline later, so disallowed types (HTML/SVG) must be rejected up front.
  const safeFileMime = b.file ? assertUploadMime(b.file_mime) : null;
  assertUploadSize(b.file);
  const fileArgs = [fileBuf, safeFileMime, b.file_name ?? null];
  let invoiceId = id;
  if (id) {
    const r = await client.query(
      `UPDATE utility_invoices SET provider=$2, invoice_date=$3, period_start=$4, period_end=$5,
         due_date=$6, paid=$7, paid_date=$8, notes=$9, category_id=$10, account_id=$11, channel=$12, late_total=$13,
         file=COALESCE($14, file), file_mime=COALESCE($15, file_mime), file_name=COALESCE($16, file_name)
       WHERE id=$1 AND book_id=$17 RETURNING id`,
      [id, ...fields, ...fileArgs, bookId]
    );
    if (!r.rows[0]) throw new HttpError(404, 'Invoice not found');
    await client.query(`DELETE FROM utility_invoice_lines WHERE invoice_id = $1 AND book_id = $2`, [id, bookId]);
  } else {
    const r = await client.query(
      `INSERT INTO utility_invoices (provider, invoice_date, period_start, period_end, due_date, paid, paid_date, notes, category_id, account_id, channel, late_total, file, file_mime, file_name, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [...fields, ...fileArgs, bookId]
    );
    invoiceId = r.rows[0].id;
  }
  for (const l of (b.lines ?? []) as any[]) {
    if (l.amount == null || l.amount === '') continue;
    money(l.amount, 'line amount');
    optionalNumber(l.usage_quantity, 'usage_quantity'); // NUMERIC(16,3): usage (kWh, etc.), not money
    const utility_account_id = await ownedRef('utility_account', l.utility_account_id, bookId, 'utility_account_id');
    await client.query(
      `INSERT INTO utility_invoice_lines (invoice_id, utility_account_id, description, amount, usage_quantity, usage_unit, notes, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [invoiceId, utility_account_id, clampText(l.description, 500), l.amount, l.usage_quantity ?? null, clampText(l.usage_unit, 50), clampText(l.notes, 2000), bookId]
    );
  }
  return invoiceId;
}

// Recompute an invoice's derived paid state from its payment ledger: paid once
// the payments cover the line total; paid_date is the latest payment; the linked
// transaction_id points at the most recent payment that has one (for display).
export async function recomputeInvoicePaid(client: any, invoiceId: number, bookId: number): Promise<void> {
  // Two-layer tenant isolation: book_id is required on every line/payment read and on
  // the UPDATE, so this can't read or rewrite another book's invoice even if RLS is off.
  const r = (await client.query(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM utility_invoice_lines    WHERE invoice_id = $1 AND book_id = $2), 0) AS total,
       COALESCE((SELECT SUM(amount) FROM utility_invoice_payments WHERE invoice_id = $1 AND book_id = $2), 0) AS paid_amt`,
    [invoiceId, bookId]
  )).rows[0];
  const total = Number(r.total), paid = Number(r.paid_amt);
  const isPaid = total > 0 && paid + 0.005 >= total;
  await client.query(
    `UPDATE utility_invoices SET
       paid = $2,
       paid_date = CASE WHEN $2 THEN (SELECT MAX(paid_date) FROM utility_invoice_payments WHERE invoice_id = $1 AND book_id = $3) ELSE NULL END,
       transaction_id = (SELECT transaction_id FROM utility_invoice_payments
                          WHERE invoice_id = $1 AND book_id = $3 AND transaction_id IS NOT NULL
                          ORDER BY paid_date DESC NULLS LAST, id DESC LIMIT 1)
     WHERE id = $1 AND book_id = $3`,
    [invoiceId, isPaid, bookId]
  );
}

// Pay off an invoice's remaining balance now: create one expense transaction for
// the outstanding amount (auto-filed under the utility's category, tagged with
// its property) and record it as a payment. No-op if already fully covered.
async function payInvoiceInFull(client: any, invoiceId: number, paidDate: string | null, channel: string | null, bookId: number): Promise<void> {
  const inv = (await client.query(
    `SELECT i.*,
       COALESCE((SELECT SUM(amount) FROM utility_invoice_lines    WHERE invoice_id = i.id AND book_id = $2), 0) AS total,
       COALESCE((SELECT SUM(amount) FROM utility_invoice_payments WHERE invoice_id = i.id AND book_id = $2), 0) AS paid_amt
     FROM utility_invoices i WHERE id = $1 AND book_id = $2 FOR UPDATE OF i`,
    [invoiceId, bookId]
  )).rows[0];
  if (!inv) return;
  const outstanding = Number(inv.total) - Number(inv.paid_amt);
  if (outstanding <= 0.005) { await recomputeInvoicePaid(client, invoiceId, bookId); return; }

  const date = paidDate ?? inv.paid_date ?? new Date().toISOString().slice(0, 10);
  const merchant = inv.provider ?? 'Utilities';

  // Per-utility-account breakdown of this invoice (drives categorization).
  const acctRows = (await client.query(
    `SELECT l.utility_account_id AS aid, ua.name AS aname, ua.property_id AS pid, SUM(l.amount) AS amt
     FROM utility_invoice_lines l JOIN utility_accounts ua ON ua.id = l.utility_account_id AND ua.book_id = $2
     WHERE l.invoice_id = $1 AND l.book_id = $2 AND l.utility_account_id IS NOT NULL
     GROUP BY l.utility_account_id, ua.name, ua.property_id`,
    [invoiceId, bookId]
  )).rows as { aid: number; aname: string; pid: number | null; amt: string }[];
  const managedCatFor = async (aid: number): Promise<number | null> =>
    (await client.query(
      `SELECT id FROM categories WHERE managed AND source_kind = 'utility' AND source_id = $1 AND book_id = $2`,
      [aid, bookId]
    )).rows[0]?.id ?? null;

  // Record the payment transaction (its id is reused for the payment + tags below).
  // Marking a bill paid records a payment that happened, so it posts on the payment
  // date (it affects the account balance like any posted expense).
  const recordPayment = async (categoryId: number | null) => (await client.query(
    `INSERT INTO transactions (account_id, category_id, txn_date, posted_date, amount, direction, merchant, description, channel, book_id)
     VALUES ($1,$2,$3,$3,$4,'expense',$5,'Utility payment',$6,$7) RETURNING id`,
    [inv.account_id, categoryId, date, outstanding, merchant, channel ?? inv.channel ?? null, bookId]
  )).rows[0].id as number;
  const linkPayment = (txnId: number) => client.query(
    `INSERT INTO utility_invoice_payments (invoice_id, transaction_id, amount, paid_date, auto_txn, book_id) VALUES ($1,$2,$3,$4,true,$5)`,
    [invoiceId, txnId, outstanding, date, bookId]
  );

  const fullPay = Math.abs(outstanding - Number(inv.total)) <= 0.005;

  // Multi-account invoice paid in full: split the transaction by utility account so
  // each portion lands in its own managed category (e.g. Utilities - Gas / - Water),
  // tagged to its property. Partial pays / single-account fall through to one txn.
  if (acctRows.length >= 2 && fullPay) {
    const txnId = await recordPayment(null);
    await linkPayment(txnId);
    let assigned = 0;
    for (const r of acctRows) {
      const amt = Number(r.amt); assigned += amt;
      const catId = await managedCatFor(r.aid);
      const sp = (await client.query(
        `INSERT INTO transaction_splits (transaction_id, amount, category_id, notes, is_principal, book_id)
         VALUES ($1,$2,$3,$4,false,$5) RETURNING id`,
        [txnId, amt, catId, r.aname, bookId]
      )).rows[0];
      if (r.pid != null) await client.query(`INSERT INTO line_tags (split_id, kind, ref_id, book_id) VALUES ($1, 'property', $2, $3) ON CONFLICT DO NOTHING`, [sp.id, r.pid, bookId]);
    }
    const remainder = Math.round((Number(inv.total) - assigned) * 100) / 100;
    if (remainder > 0.005) {
      await client.query(
        `INSERT INTO transaction_splits (transaction_id, amount, category_id, notes, is_principal, book_id) VALUES ($1,$2,$3,'Other charges',false,$4)`,
        [txnId, remainder, inv.category_id, bookId]
      );
    }
    await recomputeInvoicePaid(client, invoiceId, bookId);
    return;
  }

  // Single-account (or partial): one categorized transaction tagged to the property.
  let categoryId = inv.category_id;
  if (acctRows.length === 1) {
    const mc = await managedCatFor(acctRows[0].aid);
    if (mc != null) categoryId = mc;
  }
  const txnId = await recordPayment(categoryId);
  await linkPayment(txnId);
  const propertyId = acctRows.length && acctRows.every((r) => r.pid === acctRows[0].pid) ? acctRows[0].pid : null;
  if (propertyId != null) {
    await client.query(`INSERT INTO line_tags (transaction_id, kind, ref_id, book_id) VALUES ($1, 'property', $2, $3) ON CONFLICT DO NOTHING`, [txnId, propertyId, bookId]);
  }
  await recomputeInvoicePaid(client, invoiceId, bookId);
}

// Pay an invoice by LINKING an existing expense instead of creating a new one. Records
// a (non-auto) payment for up to the transaction's remaining amount (its amount less
// what it already pays on other invoices) and surfaces it on the invoice's property.
// No-op if already covered or already linked.
async function payInvoiceWithExisting(client: any, invoiceId: number, transactionId: number, bookId: number): Promise<void> {
  const inv = (await client.query(
    `SELECT i.id,
       COALESCE((SELECT SUM(amount) FROM utility_invoice_lines    WHERE invoice_id = i.id AND book_id = $2), 0) AS total,
       COALESCE((SELECT SUM(amount) FROM utility_invoice_payments WHERE invoice_id = i.id AND book_id = $2), 0) AS paid_amt
     FROM utility_invoices i WHERE id = $1 AND book_id = $2 FOR UPDATE OF i`,
    [invoiceId, bookId]
  )).rows[0];
  if (!inv) return;
  // Lock the transaction so two invoices can't both claim the same remaining amount.
  const txn = (await client.query(
    `SELECT id, direction, amount, to_char(txn_date,'YYYY-MM-DD') AS txn_date FROM transactions WHERE id = $1 AND book_id = $2 FOR UPDATE`,
    [transactionId, bookId]
  )).rows[0];
  if (!txn) throw new HttpError(404, 'Linked transaction not found.');
  if (txn.direction !== 'expense') throw new HttpError(400, 'Only an expense (money going out) can be linked as a bill payment.');
  const outstanding = Number(inv.total) - Number(inv.paid_amt);
  if (outstanding <= 0.005) { await recomputeInvoicePaid(client, invoiceId, bookId); return; }

  const already = (await client.query(`SELECT 1 FROM utility_invoice_payments WHERE invoice_id = $1 AND transaction_id = $2 AND book_id = $3 LIMIT 1`, [invoiceId, transactionId, bookId])).rows[0];
  if (!already) {
    // A payment can only cover what the transaction actually paid, less what it
    // already covers on other invoices. Credit up to the outstanding balance.
    const usedElsewhere = Number((await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS used FROM utility_invoice_payments WHERE transaction_id = $1 AND book_id = $2`,
      [transactionId, bookId]
    )).rows[0].used);
    const available = Math.round((Number(txn.amount) - usedElsewhere) * 100) / 100;
    if (available <= 0.005) throw new HttpError(409, 'That transaction is already fully applied to other bills.');
    const credit = Math.min(outstanding, available);
    await client.query(
      `INSERT INTO utility_invoice_payments (invoice_id, transaction_id, amount, paid_date, auto_txn, book_id)
       VALUES ($1,$2,$3,$4,false,$5)`,
      [invoiceId, transactionId, credit, txn.txn_date, bookId]
    );

    // Linked-transaction enrichment is additive only — never touch a split transaction.
    const split = (await client.query(`SELECT 1 FROM transaction_splits WHERE transaction_id = $1 AND book_id = $2 LIMIT 1`, [transactionId, bookId])).rows[0];

    // Single-account invoice: re-categorize the transaction to that utility's managed
    // category (e.g. "Utilities - Gas") and tag it to the utility account — so it counts
    // toward the utility's spending just like an auto-created payment would.
    const acctIds = (await client.query(
      `SELECT array_agg(DISTINCT l.utility_account_id) AS ids FROM utility_invoice_lines l WHERE l.invoice_id = $1 AND l.book_id = $2 AND l.utility_account_id IS NOT NULL`,
      [invoiceId, bookId]
    )).rows[0]?.ids as number[] | null;
    if (!split && acctIds && acctIds.length === 1) {
      const mc = (await client.query(
        `SELECT id FROM categories WHERE managed AND source_kind = 'utility' AND source_id = $1 AND book_id = $2`,
        [acctIds[0], bookId]
      )).rows[0];
      if (mc) await client.query(`UPDATE transactions SET category_id = $1 WHERE id = $2 AND book_id = $3`, [mc.id, transactionId, bookId]);
    }

    // Surface it on the property too, but only additively (skip already-tagged).
    const props = (await client.query(
      `SELECT array_agg(DISTINCT ua.property_id) AS ids FROM utility_invoice_lines l JOIN utility_accounts ua ON ua.id = l.utility_account_id AND ua.book_id = $2 WHERE l.invoice_id = $1 AND l.book_id = $2 AND ua.property_id IS NOT NULL`,
      [invoiceId, bookId]
    )).rows[0]?.ids as number[] | null;
    const propertyId = props && props.length === 1 ? props[0] : null;
    if (propertyId && !split) {
      const tagged = (await client.query(`SELECT 1 FROM line_tags WHERE transaction_id = $1 AND kind = 'property' AND ref_id = $2 AND book_id = $3 LIMIT 1`, [transactionId, propertyId, bookId])).rows[0];
      if (!tagged) await client.query(`INSERT INTO line_tags (transaction_id, kind, ref_id, book_id) VALUES ($1, 'property', $2, $3) ON CONFLICT DO NOTHING`, [transactionId, propertyId, bookId]);
    }
  }
  await recomputeInvoicePaid(client, invoiceId, bookId);
}

// Reverse the convenience "mark paid" action: delete auto-created payment
// transactions (cascade removes their payment rows). Real, user-entered payments
// are left in place, so an invoice partly paid by real transactions stays so.
async function removeAutoPayments(client: any, invoiceId: number, bookId: number): Promise<void> {
  const txnIds = (await client.query(
    `SELECT transaction_id FROM utility_invoice_payments WHERE invoice_id = $1 AND book_id = $2 AND auto_txn AND transaction_id IS NOT NULL`,
    [invoiceId, bookId]
  )).rows.map((x: any) => x.transaction_id);
  if (txnIds.length) await client.query(`DELETE FROM transactions WHERE id = ANY($1) AND book_id = $2`, [txnIds, bookId]);
  await client.query(`DELETE FROM utility_invoice_payments WHERE invoice_id = $1 AND book_id = $2 AND auto_txn`, [invoiceId, bookId]);
  await recomputeInvoicePaid(client, invoiceId, bookId);
}

utilities.post(
  '/invoices',
  ah(async (req, res) => {
    const bookId = hh(req);
    const linkTxn = req.body.payment_transaction_id ? Number(req.body.payment_transaction_id) : null;
    const id = await withTransaction(async (client) => {
      const newId = await saveInvoice(client, null, req.body, bookId);
      if (req.body.paid && linkTxn) await payInvoiceWithExisting(client, newId!, linkTxn, bookId);
      else if (req.body.paid) await payInvoiceInFull(client, newId!, req.body.paid_date ?? null, req.body.channel ?? null, bookId);
      else await recomputeInvoicePaid(client, newId!, bookId);
      return newId;
    });
    res.status(201).json({ id });
  })
);

// Potential transactions to link as an invoice payment: expense transactions near
// the given amount and date that aren't already a utility payment (newest / closest
// first). Mirrors the vehicle "link an existing transaction" pickers.
utilities.get(
  '/payment-candidates',
  ah(async (req, res) => {
    const bookId = hh(req);
    const amt = Number(req.query.amount);
    const hasAmount = Number.isFinite(amt) && amt > 0;
    const tol = hasAmount ? Math.max(2, amt * 0.05) : 0;
    const date = optionalDateOnly(req.query.date as any, 'date');
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    // Order: closest amount, then closest date, then most recent.
    const order = [hasAmount ? 'abs(t.amount - $3)' : null, date ? 'abs(t.txn_date - $5::date)' : null, 't.txn_date DESC', 't.id DESC'].filter(Boolean).join(', ');
    res.json(await query(
      `SELECT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.merchant, t.description, a.name AS account_name
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.book_id = $1 AND t.direction = 'expense'
         AND ($2::int IS NULL OR t.account_id = $2)
         AND ($3::numeric IS NULL OR abs(t.amount - $3) <= $4)
         -- Only constrain by date when there's no amount to match on; a strong amount
         -- match should surface regardless of how old the transaction is.
         AND ($3::numeric IS NOT NULL OR $5::date IS NULL OR t.txn_date BETWEEN $5::date - INTERVAL '90 days' AND $5::date + INTERVAL '90 days')
         AND NOT EXISTS (SELECT 1 FROM utility_invoice_payments p WHERE p.transaction_id = t.id AND p.book_id = $1)
       ORDER BY ${order}
       LIMIT 40`,
      [bookId, accountId, hasAmount ? amt : null, tol, date]
    ));
  })
);

utilities.put(
  '/invoices/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const id = Number(req.params.id);
    const linkTxn = req.body.payment_transaction_id ? Number(req.body.payment_transaction_id) : null;
    await withTransaction(async (client) => {
      await saveInvoice(client, id, req.body, bookId);
      if (req.body.paid && linkTxn) await payInvoiceWithExisting(client, id, linkTxn, bookId);
      else if (req.body.paid) await payInvoiceInFull(client, id, req.body.paid_date ?? null, req.body.channel ?? null, bookId);
      else await removeAutoPayments(client, id, bookId);
    });
    res.json({ id });
  })
);

// Mark paid (pays the remaining balance now) / unpay (removes auto payments).
utilities.post(
  '/invoices/:id/pay',
  ah(async (req, res) => {
    const bookId = hh(req);
    const paid = req.body?.paid !== false;
    const id = Number(req.params.id);
    await withTransaction(async (client) => {
      if (!(await client.query(`SELECT 1 FROM utility_invoices WHERE id = $1 AND book_id = $2`, [id, bookId])).rows[0]) throw new HttpError(404, 'Invoice not found');
      if (paid) await payInvoiceInFull(client, id, req.body?.paid_date ?? null, req.body?.channel ?? null, bookId);
      else await removeAutoPayments(client, id, bookId);
    });
    res.json({ ok: true });
  })
);

utilities.delete(
  '/invoices/:id',
  ah(async (req, res) => {
    await query(`DELETE FROM utility_invoices WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// --- Account-level documents for a utility account (statements, agreements, …) ---
utilities.get(
  '/accounts/:id/documents',
  ah(async (req, res) => {
    await ownedUtilityAccount(req);
    res.json(await query(
      `SELECT id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM utility_account_documents WHERE utility_account_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

utilities.post(
  '/accounts/:id/documents',
  ah(async (req, res) => {
    require_(req.body, ['file']);
    const bookId = hh(req);
    await ownedUtilityAccount(req);
    const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
    if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
    const safeMime = assertUploadMime(file_mime);
    assertUploadSize(file);
    const buf = Buffer.from(file, 'base64');
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const row = await one(
      `INSERT INTO utility_account_documents (utility_account_id, book_id, doc_type, name, file, file_mime, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
      [req.params.id, bookId, docType, name || file_name, buf, safeMime, file_name]
    );
    res.status(201).json(row);
  })
);

utilities.put(
  '/accounts/:id/documents/:docId',
  ah(async (req, res) => {
    await ownedUtilityAccount(req);
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
        `UPDATE utility_account_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
         WHERE id = $6 AND utility_account_id = $7 AND book_id = $8 ${returning}`,
        [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
      );
    } else {
      row = await one(
        `UPDATE utility_account_documents SET name = $1, doc_type = $2
         WHERE id = $3 AND utility_account_id = $4 AND book_id = $5 ${returning}`,
        [name, docType, req.params.docId, req.params.id, hh(req)]
      );
    }
    if (!row) throw new HttpError(404, 'Document not found.');
    res.json(row);
  })
);

utilities.get(
  '/accounts/:id/documents/:docId/file',
  ah(async (req, res) => {
    await ownedUtilityAccount(req);
    const r = await one<any>(
      `SELECT file, file_mime, file_name FROM utility_account_documents WHERE id = $1 AND utility_account_id = $2 AND book_id = $3`,
      [req.params.docId, req.params.id, hh(req)]
    );
    if (!r || !r.file) throw new HttpError(404, 'Document not found.');
    sendStoredFile(res, r.file, r.file_mime, r.file_name);
  })
);

utilities.delete(
  '/accounts/:id/documents/:docId',
  ah(async (req, res) => {
    await query(`DELETE FROM utility_account_documents WHERE id = $1 AND utility_account_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
    res.status(204).end();
  })
);
