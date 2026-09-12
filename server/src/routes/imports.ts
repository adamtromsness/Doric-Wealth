import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { parseCsv } from '../csv.js';
import { insertTransaction, applyTransactionToInvoices } from './transactions.js';
import { integerId, assertOwned, ownedRef, optionalMoney, optionalDateOnly, optionalEnumValue } from '../validation.js';

export const imports = Router();

const MAX_ROWS = 5000;

// --- Parsing helpers -------------------------------------------------------
const pad = (s: string | number) => String(s).padStart(2, '0');

// Parse common date formats to YYYY-MM-DD, or null.
function parseDate(s: string | undefined): string | null {
  s = (s ?? '').trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  // ISO yyyy-mm-dd — unambiguous.
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // d/m/y or m/d/y. Disambiguate by value: a field > 12 can only be the day, so
  // "13/06/2026" is correctly read as 13 June, not month 13. When both fields are
  // <= 12 it's genuinely ambiguous and we keep the US month-first convention.
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s))) {
    const a = Number(m[1]); const b = Number(m[2]); let y = m[3];
    let mo: number; let d: number;
    if (a > 12 && b <= 12) { d = a; mo = b; }       // first field must be the day
    else { mo = a; d = b; }                          // US month-first (default)
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (y.length === 2) {
      // Pivot 2-digit years so "98" is 1998, not 2098: 00–69 → 2000s, 70–99 → 1900s.
      const yy = Number(y);
      y = String(yy <= 69 ? 2000 + yy : 1900 + yy);
    }
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  // Last resort (named months, etc.): parse, but format from LOCAL components so we
  // don't shift the calendar day by reformatting through UTC (toISOString).
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Parse a money string ("$1,234.56", "(50.00)" = negative) to a number, or null.
function parseAmount(s: string | undefined): number | null {
  s = (s ?? '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.includes('-');
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (cleaned === '' || cleaned === '.') return null;
  const v = Number(cleaned);
  if (Number.isNaN(v)) return null;
  return neg ? -v : v;
}

// Strip common bank/processor noise from a raw descriptor and Title-Case it.
export function cleanMerchant(raw: string | undefined): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^(sq ?\*|tst\*|sp ?\*|pp\*|paypal ?\*|pos debit|pos|purchase|ach|debit card|checkcard \d+)\s*/i, '');
  s = s.replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?$/, ''); // trailing date
  s = s.replace(/\s+#?\d{3,}$/, '');                     // trailing store/ref number
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (!s) return (raw ?? '').trim();
  // Title-case each word (bank descriptors are usually ALL-CAPS); the user can
  // tweak the spelling in review.
  return s
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

// If the cleaned merchant matches a known canonical name, prefer the canonical
// spelling. `known` is ordered most-used first, so the most common wins.
function canonicalize(cleaned: string, known: string[]): string {
  const lc = cleaned.toLowerCase();
  if (!lc) return cleaned;
  for (const k of known) {
    const klc = k.toLowerCase();
    if (lc === klc || lc.includes(klc) || klc.includes(lc)) return k;
  }
  return cleaned;
}

// Whether an imported row and an existing transaction (already matched on
// account + amount + direction + nearby date) are the *same* charge. Two charges
// for the same amount on the same day but with different merchants (e.g. two
// separate $20 purchases) are NOT duplicates — they get staged for review rather
// than silently skipped.
function sameMerchant(a: string | null, b: string | null): boolean {
  const x = (a ?? '').trim().toLowerCase();
  const y = (b ?? '').trim().toLowerCase();
  if (!x && !y) return true;     // neither has merchant info → fall back to amount+date
  if (!x || !y) return false;    // one side unknown → don't auto-skip; let the user decide
  if (x === y) return true;
  return x.includes(y) || y.includes(x); // tolerate store#/city noise around the same name
}

interface Mapping { date: number; amount?: number; debit?: number; credit?: number; merchant?: number; description?: number }

// Best-guess column mapping from header names.
function detectMapping(headers: string[]): Mapping {
  const find = (...keys: string[]) => {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (keys.some((k) => h.includes(k))) return i;
    }
    return undefined;
  };
  const date = find('date', 'posted') ?? 0;
  const debit = find('debit', 'withdrawal');
  const credit = find('credit', 'deposit');
  const amount = find('amount', 'amt');
  const description = find('description', 'memo', 'name', 'payee', 'merchant');
  const merchant = find('merchant', 'payee', 'name') ?? description;
  const map: Mapping = { date, description, merchant };
  if (amount != null) map.amount = amount;
  if (debit != null) map.debit = debit;
  if (credit != null) map.credit = credit;
  if (map.amount == null && map.debit == null && map.credit == null && headers.length) map.amount = headers.length - 1;
  return map;
}

interface NormalRow { txn_date: string | null; amount: number; direction: 'expense' | 'income'; raw_merchant: string | null; description: string | null }

function normalizeRow(cols: string[], map: Mapping, negExpense: boolean): NormalRow | null {
  const txn_date = parseDate(cols[map.date]);
  const rawDesc = map.description != null ? (cols[map.description] ?? '').trim() : '';
  const rawMerch = map.merchant != null ? (cols[map.merchant] ?? '').trim() : rawDesc;

  let amount: number;
  let direction: 'expense' | 'income';
  if (map.debit != null || map.credit != null) {
    const debit = map.debit != null ? parseAmount(cols[map.debit]) : null;
    const credit = map.credit != null ? parseAmount(cols[map.credit]) : null;
    if (credit && Math.abs(credit) > 0) { direction = 'income'; amount = Math.abs(credit); }
    else if (debit && Math.abs(debit) > 0) { direction = 'expense'; amount = Math.abs(debit); }
    else return null;
  } else if (map.amount != null) {
    const a = parseAmount(cols[map.amount]);
    if (a == null) return null;
    const isExpense = negExpense ? a < 0 : a > 0;
    direction = isExpense ? 'expense' : 'income';
    amount = Math.abs(a);
  } else return null;

  if (!amount) return null;
  return { txn_date, amount, direction, raw_merchant: rawMerch || null, description: rawDesc || null };
}

// Record the latest import outcome for an account so the account list/detail can
// surface last_import_at / status / error. One row per account (UNIQUE account_id).
// Called inside the import transaction so the status moves atomically with the data.
export async function setImportStatus(
  client: { query: (text: string, params: any[]) => Promise<unknown> },
  bookId: number,
  accountId: number,
  status: 'staged' | 'imported' | 'failed',
  error: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO account_import_status (book_id, account_id, last_import_at, last_import_status, last_import_error, updated_at)
     VALUES ($1, $2, now(), $3, $4, now())
     ON CONFLICT (account_id) DO UPDATE SET
       last_import_at     = now(),
       last_import_status = EXCLUDED.last_import_status,
       last_import_error  = EXCLUDED.last_import_error,
       updated_at         = now()`,
    [bookId, accountId, status, error]
  );
}

// After confirming staged rows, settle the import status of every affected
// account. An account is marked `imported` once it has no remaining staged rows
// still flagged for import — so a row re-pointed from account A to B clears A's
// stale `staged` status too, while accounts that still have pending import rows
// keep it. Leftover `skip` rows do NOT hold an account open.
async function refreshImportedStatus(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  accountIds: Iterable<number | null | undefined>,
): Promise<void> {
  for (const aid of new Set(accountIds)) {
    if (aid == null) continue;
    const pending = (await client.query(
      `SELECT 1 FROM staged_transactions WHERE book_id = $1 AND account_id = $2 AND decision = 'import' LIMIT 1`,
      [bookId, aid]
    )).rows[0];
    if (!pending) await setImportStatus(client, bookId, aid, 'imported');
  }
}

// --- Routes ----------------------------------------------------------------

// Parse the CSV and return headers, a small sample, and a suggested mapping.
// Stateless — nothing is persisted until POST /.
imports.post(
  '/preview',
  ah(async (req, res) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) throw new HttpError(400, 'No CSV content provided.');
    // Preview only needs a sample + a count, so cap parsing at the same ceiling the
    // commit uses (MAX_ROWS) rather than parsing an arbitrarily large file in full.
    const { headers, rows } = parseCsv(text, { maxRows: MAX_ROWS });
    if (!headers.length) throw new HttpError(422, 'Could not read a header row from this CSV.');
    res.json({
      headers,
      sampleRows: rows.slice(0, 8),
      rowCount: rows.length,
      rowCountCapped: rows.length >= MAX_ROWS,
      suggestedMapping: detectMapping(headers),
    });
  })
);

// Commit an import: parse + map + standardize + dedup, then persist staged rows.
imports.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['text', 'mapping']);
    const bookId = hh(req);
    const accountId = integerId(req.body.account_id, 'account_id');
    const map = req.body.mapping as Mapping;
    const negExpense = req.body.amountsNegativeAreExpense !== false; // default true
    const filename = req.body.filename ? String(req.body.filename) : null;

    await assertOwned('account', accountId, bookId);
    // From here the account is known/owned, so any parse/processing failure should
    // be recorded against it as a failed import (see the try/catch below). A bad or
    // cross-book account_id never reaches this point — integerId/assertOwned
    // already threw, so no status is written for an unknown account.

    let result: any;
    try {
    const { headers, rows: allRows } = parseCsv(String(req.body.text));
    if (!headers.length) throw new HttpError(422, 'Could not read a header row from this CSV.');
    const rows = allRows.slice(0, MAX_ROWS);
    const truncated = allRows.length - rows.length;

    // History used for standardization (load once).
    const known = (await query<{ merchant: string }>(
      `SELECT merchant FROM transactions WHERE merchant IS NOT NULL AND merchant <> '' AND book_id = $1
       GROUP BY merchant ORDER BY count(*) DESC, merchant`,
      [bookId]
    )).map((r) => r.merchant);
    const catRows = await query<{ m: string; category_id: number; n: number }>(
      `SELECT lower(merchant) AS m, category_id, count(*)::int AS n
       FROM transactions WHERE book_id = $1 AND merchant IS NOT NULL AND category_id IS NOT NULL
       GROUP BY lower(merchant), category_id`,
      [bookId]
    );
    const catByMerchant = new Map<string, { category_id: number; n: number }>();
    for (const r of catRows) {
      const cur = catByMerchant.get(r.m);
      if (!cur || r.n > cur.n) catByMerchant.set(r.m, { category_id: r.category_id, n: r.n });
    }

    // Existing committed transactions in THIS account, prefetched once for the
    // cross-existing dedup (the import is always scoped to one account, so this is
    // bounded). Matching in memory replaces a per-row range query — keyed by
    // cents+direction, then filtered to ±4 days and a matching merchant, closest first
    // — mirroring the SQL it replaces.
    const existingTxns = await query<{ id: number; amount: number; direction: string; txn_date: string; merchant: string | null }>(
      `SELECT id, amount, direction, to_char(txn_date,'YYYY-MM-DD') AS txn_date, merchant
         FROM transactions WHERE book_id = $1 AND account_id = $2`,
      [bookId, accountId]
    );
    const existingByKey = new Map<string, { id: number; txn_date: string; merchant: string | null }[]>();
    for (const t of existingTxns) {
      const k = `${Math.round(Number(t.amount) * 100)}|${t.direction}`;
      let g = existingByKey.get(k); if (!g) { g = []; existingByKey.set(k, g); }
      g.push({ id: t.id, txn_date: t.txn_date, merchant: t.merchant });
    }
    const daysApartDate = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
    const findExistingDup = (amount: number, direction: string, txnDate: string, merchant: string | null) =>
      (existingByKey.get(`${Math.round(amount * 100)}|${direction}`) ?? [])
        .filter((c) => daysApartDate(c.txn_date, txnDate) <= 4)
        .sort((a, b) => daysApartDate(a.txn_date, txnDate) - daysApartDate(b.txn_date, txnDate))
        .slice(0, 10)
        .find((c) => sameMerchant(merchant, c.merchant)) ?? null;

    result = await withTransaction(async (client) => {
      const batch = (await client.query(
        `INSERT INTO import_batches (book_id, account_id, filename, source, total_rows, created_by)
         VALUES ($1,$2,$3,'csv',$4,$5) RETURNING id`,
        [bookId, accountId, filename, rows.length, req.user?.id ?? null]
      )).rows[0];

      let duplicates = 0;
      let invalid = 0;
      const seen = new Set<string>();
      const stagedRows: any[][] = [];

      for (const cols of rows) {
        const norm = normalizeRow(cols, map, negExpense);
        if (!norm || !norm.txn_date) { invalid++; continue; }

        const merchant = canonicalize(cleanMerchant(norm.raw_merchant ?? ''), known) || null;
        const suggestion = merchant ? catByMerchant.get(merchant.toLowerCase()) : undefined;

        // Within-batch duplicate?
        const key = `${norm.amount}|${norm.txn_date}|${(merchant ?? '').toLowerCase()}`;
        let decision: 'import' | 'skip' = 'import';
        let dupOf: number | null = null;
        let skipReason: 'duplicate_in_file' | 'matches_existing' | null = null;
        if (seen.has(key)) { decision = 'skip'; skipReason = 'duplicate_in_file'; duplicates++; }
        else {
          seen.add(key);
          // Against existing transactions in the same account (prefetched above): same
          // amount + direction, within ±4 days, AND a matching merchant.
          const dup = findExistingDup(norm.amount, norm.direction, norm.txn_date, merchant);
          if (dup) { dupOf = dup.id; decision = 'skip'; skipReason = 'matches_existing'; duplicates++; }
        }

        const raw: Record<string, string> = {};
        headers.forEach((h, i) => { raw[h] = cols[i] ?? ''; });

        stagedRows.push([
          bookId, batch.id, 'csv', accountId, suggestion?.category_id ?? null, norm.txn_date, norm.amount,
          norm.direction, merchant, norm.raw_merchant, norm.description, JSON.stringify(raw), dupOf, decision, skipReason,
        ]);
      }

      // Chunked multi-row insert of all staged rows (was one INSERT per row).
      const SCOLS = ['book_id', 'batch_id', 'source', 'account_id', 'category_id', 'txn_date', 'amount', 'direction', 'merchant', 'raw_merchant', 'description', 'raw', 'duplicate_of', 'decision', 'skip_reason'];
      const sColSql = SCOLS.map((c) => `"${c}"`).join(',');
      const sPerChunk = Math.max(1, Math.floor(60000 / SCOLS.length));
      for (let i = 0; i < stagedRows.length; i += sPerChunk) {
        const chunk = stagedRows.slice(i, i + sPerChunk);
        const params: any[] = [];
        const tuples = chunk.map((vals) => `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
        await client.query(`INSERT INTO staged_transactions (${sColSql}) VALUES ${tuples.join(',')}`, params);
      }

      await client.query(`UPDATE import_batches SET duplicate_count = $2 WHERE id = $1`, [batch.id, duplicates]);

      // Update this account's import status. Every non-invalid row lands in
      // staged_transactions; if nothing could be staged the import effectively failed.
      const stagedCount = rows.length - invalid;
      if (stagedCount > 0) {
        await setImportStatus(client, bookId, accountId, 'staged');
      } else {
        await setImportStatus(client, bookId, accountId, 'failed',
          rows.length === 0 ? 'No data rows found in the file.' : 'No valid rows could be imported from the file.');
      }

      return { batch_id: batch.id, total: rows.length, imported: rows.length - duplicates - invalid, duplicates, invalid, truncated };
    });
    } catch (err) {
      // Known account: record the failed attempt (best-effort, on the request
      // connection) without masking the original error or its HTTP status code.
      const message = err instanceof HttpError ? err.message : 'The import file could not be processed.';
      try { await setImportStatus({ query: (t, p) => query(t, p) }, bookId, accountId, 'failed', message); } catch { /* never mask the original error */ }
      throw err;
    }

    res.status(201).json(result);
  })
);

// List staged rows for the active book, enriched for display.
imports.get(
  '/staged',
  ah(async (req, res) => {
    const rows = await query(
      `SELECT s.*, to_char(s.txn_date,'YYYY-MM-DD') AS txn_date,
              a.name AS account_name, c.name AS category_name,
              d.merchant AS dup_merchant, to_char(d.txn_date,'YYYY-MM-DD') AS dup_date, d.amount AS dup_amount
       FROM staged_transactions s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN transactions d ON d.id = s.duplicate_of
       WHERE s.book_id = $1
       ORDER BY s.txn_date DESC NULLS LAST, s.id`,
      [hh(req)]
    );
    res.json(rows);
  })
);

// Edit a staged row before confirming (also used to toggle import/skip).
imports.put(
  '/staged/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const b = req.body ?? {};
    // Validate referenced account/category belong to the book, and the value fields.
    await ownedRef('account', b.account_id, bookId, 'account_id');
    await ownedRef('category', b.category_id, bookId, 'category_id');
    optionalMoney(b.amount, 'amount');
    optionalDateOnly(b.txn_date, 'txn_date');
    optionalEnumValue(b.direction, 'direction', ['expense', 'income']);
    // Only overwrite a field the caller actually sent. A key that is present but
    // null clears it (intentional); a key that is omitted is preserved — so e.g.
    // toggling `decision` or editing only `account_id` can't blank out the row's
    // other fields. (direction/decision are NOT NULL, so they only ever change to
    // a real value.)
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const decision = b.decision === 'skip' ? 'skip' : 'import';
    const row = await one(
      `UPDATE staged_transactions SET
         account_id  = CASE WHEN $11 THEN $2 ELSE account_id  END,
         category_id = CASE WHEN $12 THEN $3 ELSE category_id END,
         txn_date    = COALESCE($4, txn_date),
         amount      = COALESCE($5, amount),
         direction   = COALESCE($6, direction),
         merchant    = CASE WHEN $13 THEN $7 ELSE merchant    END,
         description = CASE WHEN $14 THEN $8 ELSE description END,
         decision    = CASE WHEN $15 THEN $9 ELSE decision    END
       WHERE id = $1 AND book_id = $10 RETURNING *`,
      [
        req.params.id, b.account_id ?? null, b.category_id ?? null, b.txn_date ?? null, b.amount ?? null,
        b.direction ?? null, b.merchant ?? null, b.description ?? null, decision, bookId,
        has('account_id'), has('category_id'), has('merchant'), has('description'), has('decision'),
      ]
    );
    if (!row) throw new HttpError(404, 'Staged transaction not found');
    res.json(row);
  })
);

// Build the transaction body for a staged row (confirmed rows become posted).
function stagedToTxn(s: any) {
  return {
    account_id: s.account_id, category_id: s.category_id, txn_date: s.txn_date, posted_date: s.txn_date,
    amount: s.amount, direction: s.direction, merchant: s.merchant, description: s.description,
    // Preserve provider provenance (source/external_id) so re-syncs dedup correctly.
    source: s.source, external_id: s.external_id,
  };
}

// --- Transfer pairing among staged rows ------------------------------------
// Two imported lines are likely the two halves of one transfer when they're in two
// different accounts, equal magnitude, opposite direction, within a few days. The
// "out" (expense) is the source account; the "in" (income) is the destination.
const TRANSFER_DAY_WINDOW = 4;
const daysApart = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

// Pair pending staged rows that look like the two halves of one transfer: opposite
// direction, equal magnitude, two different accounts, within a few days. `out` is the
// money-out (expense → source account), `in` is the money-in (income → destination).
async function findStagedTransferCandidates(client: any, bookId: number): Promise<{ out: any; in: any }[]> {
  const rows = (await client.query(
    `SELECT s.id, s.account_id, a.name AS account_name, to_char(s.txn_date,'YYYY-MM-DD') AS txn_date,
            s.amount::float8 AS amount, s.direction, s.merchant, s.description
       FROM staged_transactions s JOIN accounts a ON a.id = s.account_id
      WHERE s.book_id = $1 AND s.decision = 'import'
      ORDER BY s.amount, s.txn_date`,
    [bookId]
  )).rows;
  const used = new Set<number>();
  const incomes = rows.filter((r: any) => r.direction === 'income');
  const pairs: { out: any; in: any }[] = [];
  for (const out of rows) {
    if (out.direction !== 'expense' || used.has(out.id)) continue;
    const match = incomes.find((inc: any) =>
      !used.has(inc.id) && inc.account_id !== out.account_id &&
      Math.abs(inc.amount - out.amount) < 0.005 && daysApart(inc.txn_date, out.txn_date) <= TRANSFER_DAY_WINDOW);
    if (match) { used.add(out.id); used.add(match.id); pairs.push({ out, in: match }); }
  }
  return pairs;
}

// Merge two staged rows (by id) into ONE transfer transaction, record both provider ids
// so neither re-imports, and delete both staged rows. Returns the created transaction.
async function mergeStagedTransfer(client: any, bookId: number, outId: number, inId: number) {
  const load = async (id: number) =>
    (await client.query(`SELECT * FROM staged_transactions WHERE id = $1 AND book_id = $2`, [id, bookId])).rows[0];
  const a = await load(outId);
  const b = await load(inId);
  if (!a || !b) throw new HttpError(404, 'Staged transaction not found.');
  if (a.account_id === b.account_id) throw new HttpError(400, 'A transfer must be between two different accounts.');
  // Source = the money-out (expense) side; destination = the money-in side. Tolerant of order.
  const src = a.direction === 'expense' ? a : b;
  const dst = a.direction === 'expense' ? b : a;
  const created = await insertTransaction(client, bookId, {
    account_id: src.account_id, transfer_account_id: dst.account_id, direction: 'transfer',
    amount: src.amount, txn_date: src.txn_date, posted_date: src.txn_date,
    merchant: src.merchant || dst.merchant, description: src.description || dst.description,
    source: src.source, external_id: src.external_id,
  });
  for (const s of [src, dst]) {
    if (!s.external_id) continue;
    await client.query(
      `INSERT INTO consumed_external_ids (book_id, transaction_id, source, external_id)
            VALUES ($1, $2, $3, $4) ON CONFLICT (book_id, source, external_id) DO NOTHING`,
      [bookId, created.id, s.source ?? 'simplefin', s.external_id]
    );
  }
  await client.query(`DELETE FROM staged_transactions WHERE book_id = $1 AND id = ANY($2)`, [bookId, [outId, inId]]);
  await refreshImportedStatus(client, bookId, [src.account_id, dst.account_id]);
  return created;
}

// Auto-link every candidate whose account pair has a remembered transfer rule. Runs on
// the caller's client (request transaction OR the background sync's book connection).
export async function autoLinkTransferRules(client: any, bookId: number): Promise<number> {
  const rules = (await client.query(`SELECT source_account_id, dest_account_id FROM transfer_rules WHERE book_id = $1`, [bookId])).rows;
  if (!rules.length) return 0;
  const ruleSet = new Set(rules.map((r: any) => `${r.source_account_id}-${r.dest_account_id}`));
  let linked = 0;
  for (const p of await findStagedTransferCandidates(client, bookId)) {
    if (ruleSet.has(`${p.out.account_id}-${p.in.account_id}`)) {
      await mergeStagedTransfer(client, bookId, p.out.id, p.in.id);
      linked++;
    }
  }
  return linked;
}

imports.get(
  '/staged/transfer-candidates',
  ah(async (req, res) => {
    const bookId = hh(req);
    const pairs = await withTransaction((client) => findStagedTransferCandidates(client, bookId));
    res.json(pairs);
  })
);

// Apply remembered rules to the current review queue (called when the queue is loaded).
imports.post(
  '/staged/auto-link',
  ah(async (req, res) => {
    const bookId = hh(req);
    const linked = await withTransaction((client) => autoLinkTransferRules(client, bookId));
    res.json({ linked });
  })
);

// Manually link a candidate pair into one transfer; optionally remember the account pair.
imports.post(
  '/staged/transfer',
  ah(async (req, res) => {
    const bookId = hh(req);
    const outId = Number(req.body?.out_id);
    const inId = Number(req.body?.in_id);
    if (!Number.isInteger(outId) || !Number.isInteger(inId) || outId === inId) {
      throw new HttpError(400, 'Two different staged transactions are required.');
    }
    const remember = !!req.body?.remember;
    const txn = await withTransaction(async (client) => {
      const created = await mergeStagedTransfer(client, bookId, outId, inId);
      if (remember) {
        await client.query(
          `INSERT INTO transfer_rules (book_id, source_account_id, dest_account_id)
                VALUES ($1, $2, $3) ON CONFLICT (book_id, source_account_id, dest_account_id) DO NOTHING`,
          [bookId, created.account_id, created.transfer_account_id]
        );
      }
      return created;
    });
    res.status(201).json(txn);
  })
);

// Remembered auto-link rules (list + remove).
imports.get(
  '/transfer-rules',
  ah(async (req, res) => {
    const rows = await query(
      `SELECT tr.id, tr.source_account_id, sa.name AS source_name, tr.dest_account_id, da.name AS dest_name
         FROM transfer_rules tr
         JOIN accounts sa ON sa.id = tr.source_account_id
         JOIN accounts da ON da.id = tr.dest_account_id
        WHERE tr.book_id = $1 ORDER BY tr.id`,
      [hh(req)]
    );
    res.json(rows);
  })
);
imports.delete(
  '/transfer-rules/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Bad rule id.');
    await query(`DELETE FROM transfer_rules WHERE id = $1 AND book_id = $2`, [id, hh(req)]);
    res.json({ ok: true });
  })
);

// Confirm one staged row -> create a posted transaction, then remove the staged row.
imports.post(
  '/staged/:id/confirm',
  ah(async (req, res) => {
    const bookId = hh(req);
    const txn = await withTransaction(async (client) => {
      // Claim the row by deleting it first (RETURNING its data): the DELETE locks
      // the row for the transaction, so a concurrent double-click/retry finds it
      // already gone and 404s instead of posting the money twice. (CSV rows have a
      // NULL external_id, so the posted-txn unique index does NOT protect them.)
      const s = (await client.query(`DELETE FROM staged_transactions WHERE id = $1 AND book_id = $2 RETURNING *`, [req.params.id, bookId])).rows[0];
      if (!s) throw new HttpError(404, 'Staged transaction not found');
      // The row's current account plus the batch's original account (which may
      // differ if the row was re-pointed during review) must both be settled.
      const batchAcct = (await client.query(`SELECT account_id FROM import_batches WHERE id = $1 AND book_id = $2`, [s.batch_id, bookId])).rows[0]?.account_id;
      const created = await insertTransaction(client, bookId, stagedToTxn(s));
      await refreshImportedStatus(client, bookId, [s.account_id, batchAcct]);
      return created;
    });
    res.status(201).json(txn);
  })
);

// Bulk-confirm every `import` row (optionally limited to one batch). Mirrors the
// single-row POST /staged/:id/confirm and the bulk DELETE /staged.
imports.post(
  '/staged/confirm',
  ah(async (req, res) => {
    const bookId = hh(req);
    const batchId = req.body?.batch_id ?? req.query.batch_id ?? null;
    const imported = await withTransaction(async (client) => {
      // Claim all matching rows up front with a single DELETE ... RETURNING: the
      // rows are removed+locked atomically, so a concurrent bulk/single confirm
      // can't also post any of them (it sees them gone). Each claimed row then
      // becomes exactly one posted transaction.
      const rows = (await client.query(
        `DELETE FROM staged_transactions
          WHERE book_id = $1 AND decision = 'import' AND ($2::int IS NULL OR batch_id = $2)
          RETURNING *`,
        [bookId, batchId]
      )).rows;
      let n = 0;
      const affected = new Set<number>();
      const batchIds = new Set<number>();
      for (const s of rows) {
        affected.add(s.account_id);          // each row's current account
        if (s.batch_id != null) batchIds.add(s.batch_id);
      }

      // Set-based confirm: one chunked multi-row INSERT instead of insertTransaction per
      // row (which fanned out to ~6-8 sub-queries each — ~45k statements for a 5k-row
      // import). This is safe specifically for staged rows because they never carry
      // splits/tags (so the tag/split save is a no-op) and are never transfers, and their
      // account/category FKs are ON DELETE SET NULL (so each id is always a valid owned id
      // or NULL — no per-row ownership re-check needed). The one side-effect that still
      // matters — applying a utility-invoice payment — is re-run below only for the rows
      // whose category is a managed utility category (mirrors insertTransaction).
      if (rows.length) {
        const utilityCatIds = new Set<number>(
          (await client.query(`SELECT id FROM categories WHERE book_id = $1 AND managed AND source_kind = 'utility'`, [bookId])).rows.map((r: any) => r.id)
        );
        const COLS = ['book_id', 'account_id', 'category_id', 'txn_date', 'posted_date', 'amount', 'direction', 'merchant', 'description', 'source', 'external_id'];
        const colSql = COLS.map((c) => `"${c}"`).join(',');
        const perChunk = Math.max(1, Math.floor(60000 / COLS.length));
        const utilityTxnIds: number[] = [];
        for (let i = 0; i < rows.length; i += perChunk) {
          const chunk = rows.slice(i, i + perChunk);
          const params: any[] = [];
          const tuples = chunk.map((s: any) => {
            // posted_date = txn_date: a confirmed staged row is a posted transaction.
            const vals = [bookId, s.account_id ?? null, s.category_id ?? null, s.txn_date, s.txn_date, s.amount, s.direction, s.merchant ?? null, s.description ?? null, s.source ?? null, s.external_id ?? null];
            return `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`;
          });
          const ins = (await client.query(`INSERT INTO transactions (${colSql}) VALUES ${tuples.join(',')} RETURNING id, category_id`, params)).rows;
          n += ins.length;
          for (const r of ins as any[]) if (r.category_id != null && utilityCatIds.has(r.category_id)) utilityTxnIds.push(r.id);
        }
        for (const txnId of utilityTxnIds) await applyTransactionToInvoices(client, txnId, bookId);
      }
      // Also settle the ORIGINAL account of every batch we consumed rows from, so a
      // batch whose rows were all re-pointed elsewhere doesn't stay stuck on 'staged'.
      for (const bid of batchIds) {
        const a = (await client.query(`SELECT account_id FROM import_batches WHERE id = $1 AND book_id = $2`, [bid, bookId])).rows[0]?.account_id;
        if (a != null) affected.add(a);
      }
      await refreshImportedStatus(client, bookId, affected);
      return n;
    });
    res.json({ imported });
  })
);

// Discard one staged row.
imports.delete(
  '/staged/:id',
  ah(async (req, res) => {
    await query(`DELETE FROM staged_transactions WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// Discard staged rows (optionally one batch, or only the skipped ones).
imports.delete(
  '/staged',
  ah(async (req, res) => {
    const bookId = hh(req);
    const batchId = req.query.batch_id ?? null;
    const onlySkipped = req.query.decision === 'skip';
    await query(
      `DELETE FROM staged_transactions
        WHERE book_id = $1
          AND ($2::int IS NULL OR batch_id = $2)
          AND ($3 = false OR decision = 'skip')`,
      [bookId, batchId, onlySkipped]
    );
    res.status(204).end();
  })
);
