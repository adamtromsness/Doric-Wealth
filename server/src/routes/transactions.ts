import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, one, withTransaction } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { ask, askVision, AiNotConfiguredError } from '../ai/claude.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import {
  money, optionalMoney, numberValue, optionalNumber, optionalDateOnly, optionalEnumValue,
  ownedRef, assertTagRefOwned, assertSplitTotal, clampText,
  TXN_DIRECTIONS, CHANNELS,
} from '../validation.js';
import { advanceSubscriptionDueDates, recurringKey } from './subscriptions.js';
import { recomputeInvoicePaid } from './utilities.js';

export const transactions = Router();

// Confirm a transaction belongs to the active book, or 404.
async function ownedTxn(req: any): Promise<number> {
  const t = await one<{ id: number }>(`SELECT id FROM transactions WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!t) throw new HttpError(404, 'Transaction not found');
  return t.id;
}

// Reject a transaction that references accounts/categories from another book —
// otherwise a crafted account_id could poison a victim book's computed balance.
// (Runs on the request-bound transaction connection via the shared validators.)
async function assertRefsOwned(_client: any, bookId: number, b: any): Promise<void> {
  await ownedRef('account', b.account_id, bookId, 'account_id');
  await ownedRef('account', b.transfer_account_id, bookId, 'transfer_account_id');
  await ownedRef('category', b.category_id, bookId, 'category_id');
  await ownedRef('category', b.interest_category_id, bookId, 'interest_category_id');
}

// Validate the plain value fields of a transaction body (money/date/enum). Throws
// a clean 400 before any DB work. amountRequired is false for PUT (COALESCE keeps existing).
function validateTxnValues(b: any, amountRequired: boolean): void {
  if (amountRequired) money(b.amount, 'amount'); else optionalMoney(b.amount, 'amount');
  optionalDateOnly(b.txn_date, 'txn_date');
  if ('posted_date' in b) optionalDateOnly(b.posted_date, 'posted_date');
  optionalEnumValue(b.direction, 'direction', TXN_DIRECTIONS);
  optionalEnumValue(b.channel, 'channel', CHANNELS);
  optionalMoney(b.principal_amount, 'principal_amount');
}

// Subscription ids a transaction is associated with — via a subscription tag
// (kind='subscription') on the transaction itself or any split.
async function subscriptionIdsForTransaction(client: any, txnId: number): Promise<number[]> {
  const r = await client.query(
    `SELECT DISTINCT lt.ref_id AS sub_id FROM line_tags lt
     LEFT JOIN transaction_splits s ON s.id = lt.split_id
     WHERE lt.kind = 'subscription'
       AND COALESCE(s.transaction_id, lt.transaction_id) = $1`,
    [txnId]
  );
  return r.rows.map((x: any) => Number(x.sub_id));
}

// When an expense is categorized to a utility account's managed category (on the
// transaction or a split), record it as a payment against that account's oldest
// open invoice — accumulating toward the balance and closing the invoice once
// covered. Idempotent: a transaction's prior payments are cleared and re-applied
// each time, so editing its amount/category just re-derives its contribution.
export async function applyTransactionToInvoices(client: any, txnId: number, bookId: number): Promise<void> {
  // Invoices this transaction previously paid — re-derive their state afterward.
  const prev = (await client.query(`SELECT DISTINCT invoice_id FROM utility_invoice_payments WHERE transaction_id = $1 AND book_id = $2`, [txnId, bookId])).rows.map((x: any) => Number(x.invoice_id));
  await client.query(`DELETE FROM utility_invoice_payments WHERE transaction_id = $1 AND book_id = $2`, [txnId, bookId]);
  const affected = new Set<number>(prev);

  // Defense in depth: every tenant table that HAS a book_id (transactions, categories,
  // transaction_splits) is filtered explicitly so this can't reach across books even
  // if RLS is ever misconfigured. utility_invoices/lines have no book_id column — they
  // are reached only via acct_id, which is itself book-scoped through c.book_id here.
  const assoc = (await client.query(
    `SELECT c.source_id AS acct_id, t.amount AS amount
       FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE t.id = $1 AND t.book_id = $2 AND c.book_id = $2 AND t.direction = 'expense'
        AND c.managed AND c.source_kind = 'utility' AND c.source_id IS NOT NULL
     UNION ALL
     SELECT c.source_id AS acct_id, s.amount AS amount
       FROM transaction_splits s JOIN categories c ON c.id = s.category_id
       JOIN transactions t ON t.id = s.transaction_id
      WHERE s.transaction_id = $1 AND s.book_id = $2 AND c.book_id = $2 AND t.direction = 'expense'
        AND c.managed AND c.source_kind = 'utility' AND c.source_id IS NOT NULL`,
    [txnId, bookId]
  )).rows as { acct_id: number; amount: string }[];

  if (assoc.length) {
    const txn = (await client.query(`SELECT txn_date FROM transactions WHERE id = $1 AND book_id = $2`, [txnId, bookId])).rows[0];
    const near = (x: number, y: number) => Math.abs(x - y) <= 0.01;
    const prevSet = new Set(prev);

    for (const a of assoc) {
      const pay = Number(a.amount);
      // Open invoices for this account, with their outstanding balance (total minus payments so far).
      const candidates = (await client.query(
        `SELECT i.id, i.late_total,
                COALESCE((SELECT SUM(l.amount) FROM utility_invoice_lines    l WHERE l.invoice_id = i.id AND l.book_id = $2), 0) AS total,
                COALESCE((SELECT SUM(pm.amount) FROM utility_invoice_payments pm WHERE pm.invoice_id = i.id AND pm.book_id = $2), 0) AS paid_amt
           FROM utility_invoices i
          WHERE i.book_id = $2 AND EXISTS (SELECT 1 FROM utility_invoice_lines l WHERE l.invoice_id = i.id AND l.book_id = $2 AND l.utility_account_id = $1)
          ORDER BY i.due_date ASC NULLS LAST, i.invoice_date ASC NULLS LAST, i.id ASC
          FOR UPDATE OF i`,
        [a.acct_id, bookId]
      )).rows as { id: number; late_total: string | null; total: string; paid_amt: string }[];
      const open = candidates
        .map((c) => ({ id: c.id, late_total: c.late_total, outstanding: Number(c.total) - Number(c.paid_amt) }))
        .filter((c) => c.outstanding > 0.005);
      if (!open.length) continue;

      // Prefer the invoice this txn paid before, then an exact-balance match, else the oldest open one.
      let pick = open.find((c) => prevSet.has(c.id))
        ?? open.find((c) => near(pay, c.outstanding) || (c.late_total != null && near(pay, Number(c.late_total))))
        ?? open[0];

      const credit = Math.min(pay, pick.outstanding);
      await client.query(
        `INSERT INTO utility_invoice_payments (invoice_id, transaction_id, amount, paid_date, auto_txn, book_id)
         VALUES ($1,$2,$3,$4,false,$5)`,
        [pick.id, txnId, credit, txn?.txn_date ?? null, bookId]
      );
      affected.add(pick.id);
    }
  }

  for (const id of affected) await recomputeInvoicePaid(client, id, bookId);
}

const TAG_KINDS = ['vehicle', 'property', 'tag', 'subscription'] as const;
type TagKind = (typeof TAG_KINDS)[number];
// Line-tag target ownership and split-category ownership are validated via the
// shared validators (assertTagRefOwned / assertOwned) at their save sites below.

// Load the vehicle/property/subscription tags for a set of transactions, with
// names resolved, split into transaction-level (split_id null) and split-level.
async function loadTags(txnIds: number[], bookId: number) {
  const byTxn = new Map<number, any[]>();
  const bySplit = new Map<number, any[]>();
  if (!txnIds.length) return { byTxn, bySplit };
  const rows = await query(
    `SELECT lt.kind, lt.ref_id, lt.split_id,
            COALESCE(s.transaction_id, lt.transaction_id) AS txn_id,
            COALESCE(v.name, p.name, tg.name) AS name
     FROM line_tags lt
     LEFT JOIN transaction_splits s ON s.id = lt.split_id AND s.book_id = $2
     LEFT JOIN vehicles v ON lt.kind = 'vehicle' AND v.id = lt.ref_id AND v.book_id = $2
     LEFT JOIN properties p ON lt.kind = 'property' AND p.id = lt.ref_id AND p.book_id = $2
     LEFT JOIN tags tg ON lt.kind = 'tag' AND tg.id = lt.ref_id AND tg.book_id = $2
     WHERE lt.book_id = $2 AND COALESCE(s.transaction_id, lt.transaction_id) = ANY($1)
     ORDER BY lt.id`,
    [txnIds, bookId]
  );
  for (const r of rows as any[]) {
    const tag = { kind: r.kind, ref_id: r.ref_id, name: r.name };
    if (r.split_id == null) {
      if (!byTxn.has(r.txn_id)) byTxn.set(r.txn_id, []);
      byTxn.get(r.txn_id)!.push(tag);
    } else {
      if (!bySplit.has(r.split_id)) bySplit.set(r.split_id, []);
      bySplit.get(r.split_id)!.push(tag);
    }
  }
  return { byTxn, bySplit };
}

// List with optional filters: ?from=&to=&category_id=&vehicle_id=&q=
transactions.get(
  '/',
  ah(async (req, res) => {
    const where: string[] = [];
    const params: any[] = [];
    const next = (val: any) => {
      params.push(val);
      return `$${params.length}`;
    };
    // Tenant scope — every transaction query is bound to the active book.
    where.push(`t.book_id = ${next(hh(req))}`);
    // Parse a (possibly comma-separated) list of numeric ids.
    const csv = (v: any) => String(v).split(',').map(Number).filter((n) => !Number.isNaN(n));
    if (req.query.from) where.push(`t.txn_date >= ${next(req.query.from)}`);
    if (req.query.to) where.push(`t.txn_date <= ${next(req.query.to)}`);
    // Tag filters match any of the given ids, on the transaction itself OR a split.
    const tagFilter = (kind: TagKind, val: any) => {
      const ids = csv(val);
      if (!ids.length) return;
      const k = next(kind);
      const p = next(ids);
      where.push(`EXISTS (
        SELECT 1 FROM line_tags lt
        LEFT JOIN transaction_splits s ON s.id = lt.split_id
        WHERE lt.kind = ${k} AND lt.ref_id = ANY(${p})
          AND COALESCE(s.transaction_id, lt.transaction_id) = t.id
      )`);
    };
    if (req.query.category_id) {
      const ids = csv(req.query.category_id);
      if (ids.length) {
        const p = next(ids);
        where.push(`(t.category_id = ANY(${p}) OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.category_id = ANY(${p})))`);
      }
    }
    // "Uncategorized only": no category on the transaction AND no categorized split,
    // excluding transfers (which are movements, not spend). Matches the To-Do count.
    if (req.query.uncategorized === '1' || req.query.uncategorized === 'true') {
      where.push(`t.category_id IS NULL AND t.direction <> 'transfer'
        AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.category_id IS NOT NULL)`);
    }
    // "Transfers only": account-to-account movements (one row, direction = 'transfer').
    if (req.query.transfers === '1' || req.query.transfers === 'true') {
      where.push(`t.direction = 'transfer'`);
    }
    if (req.query.account_id) {
      const ids = csv(req.query.account_id);
      // A transfer relates to BOTH accounts, so it shows when filtering by either
      // its source (account_id) or its destination (transfer_account_id) — e.g. a
      // loan payment is visible from both the paying account and the loan.
      if (ids.length) {
        const p = next(ids);
        where.push(`(t.account_id = ANY(${p}) OR (t.direction = 'transfer' AND t.transfer_account_id = ANY(${p})))`);
      }
    }
    if (req.query.vehicle_id) tagFilter('vehicle', req.query.vehicle_id);
    if (req.query.property_id) tagFilter('property', req.query.property_id);
    if (req.query.tag_id) tagFilter('tag', req.query.tag_id);
    if (req.query.subscription_id) tagFilter('subscription', req.query.subscription_id);
    if (req.query.q) {
      const p = next(`%${req.query.q}%`);
      where.push(`(t.merchant ILIKE ${p} OR t.description ILIKE ${p})`);
    }
    if (req.query.channel) {
      const vals = String(req.query.channel).split(',').filter(Boolean);
      if (vals.length) where.push(`t.channel = ANY(${next(vals)})`);
    }
    // Amount filter: greater than / less than / exact / between.
    const amt = req.query.amount != null && req.query.amount !== '' ? Number(req.query.amount) : null;
    if (req.query.amount_op && amt != null && !Number.isNaN(amt)) {
      const op = String(req.query.amount_op);
      if (op === 'gt') where.push(`t.amount > ${next(amt)}`);
      else if (op === 'lt') where.push(`t.amount < ${next(amt)}`);
      else if (op === 'eq') where.push(`t.amount = ${next(amt)}`);
      else if (op === 'between') {
        where.push(`t.amount >= ${next(amt)}`);
        const max = Number(req.query.amount_max);
        if (!Number.isNaN(max)) where.push(`t.amount <= ${next(max)}`);
      }
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const cond = (extra: string) => `${whereSql ? whereSql + ' AND' : 'WHERE'} ${extra}`;

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const pendingOffset = Math.max(Number(req.query.pendingOffset) || 0, 0);
    const postedOffset = Math.max(Number(req.query.postedOffset) || 0, 0);

    const SELECT = `SELECT t.*,
              c.name AS category_name,
              a.name AS account_name,
              ta.name AS transfer_account_name,
              (r.id IS NOT NULL) AS has_receipt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
       LEFT JOIN receipts r ON r.transaction_id = t.id`;
    // Sort: by transaction date (default) or posted date, newest first unless dir=asc.
    // Whitelisted, so safe to interpolate. Pending rows have no posted date, so that
    // list always sorts by transaction date (in the chosen direction).
    const sortCol = req.query.sort === 'posted_date' ? 'posted_date' : 'txn_date';
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const POSTED_ORDER = `ORDER BY t.${sortCol} ${dir}, t.txn_date ${dir}, t.id ${dir}`;
    const PENDING_ORDER = `ORDER BY t.txn_date ${dir}, t.id ${dir}`;
    const n = params.length;
    const count = async (extra: string) =>
      Number((await one<{ count: number }>(`SELECT count(*)::int AS count FROM transactions t ${cond(extra)}`, params))?.count ?? 0);

    // Pending and posted are each paginated independently (shared page size).
    const pendingRows = await query(
      `${SELECT} ${cond('t.posted_date IS NULL')} ${PENDING_ORDER} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, limit, pendingOffset]
    );
    const postedRows = await query(
      `${SELECT} ${cond('t.posted_date IS NOT NULL')} ${POSTED_ORDER} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, limit, postedOffset]
    );
    const pendingTotal = await count('t.posted_date IS NULL');
    const total = await count('t.posted_date IS NOT NULL');

    // Attach splits + tags to every returned row (both sets).
    const ids = [...pendingRows, ...postedRows].map((r: any) => r.id);
    const splits = ids.length
      ? await query(
          `SELECT s.*, c.name AS category_name
           FROM transaction_splits s
           LEFT JOIN categories c ON c.id = s.category_id AND c.book_id = $2
           WHERE s.book_id = $2 AND s.transaction_id = ANY($1) ORDER BY s.id`,
          [ids, hh(req)]
        )
      : [];
    const { byTxn, bySplit } = await loadTags(ids, hh(req));
    const splitsByTxn = new Map<number, any[]>();
    for (const s of splits as any[]) {
      if (!splitsByTxn.has(s.transaction_id)) splitsByTxn.set(s.transaction_id, []);
      splitsByTxn.get(s.transaction_id)!.push({ ...s, tags: bySplit.get(s.id) ?? [] });
    }
    const enrich = (r: any) => ({
      ...r,
      tags: byTxn.get(r.id) ?? [],
      splits: splitsByTxn.get(r.id) ?? [],
      has_splits: splitsByTxn.has(r.id),
    });

    res.json({ pending: pendingRows.map(enrich), pendingTotal, posted: postedRows.map(enrich), total });
  })
);

// Distinct merchant names (canonical spellings), most-used first — used by the
// editor for autocomplete and to standardize variant spellings.
transactions.get(
  '/merchants',
  ah(async (req, res) => {
    const rows = await query(
      `SELECT merchant, count(*)::int AS n
       FROM transactions WHERE merchant IS NOT NULL AND merchant <> '' AND book_id = $1
       GROUP BY merchant ORDER BY n DESC, merchant`,
      [hh(req)]
    );
    res.json(rows.map((r: any) => r.merchant));
  })
);

// US state abbreviations, used to drop a trailing state code from card
// descriptors (e.g. "...Chanute Ks") when comparing merchants.
const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md',
  'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
  'sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc',
]);

// Brand tokens for a merchant: the normalized key minus a trailing state code.
function merchantTokens(merchant: string): string[] {
  const toks = recurringKey(merchant).split(' ').filter(Boolean);
  if (toks.length > 1 && US_STATES.has(toks[toks.length - 1])) toks.pop();
  return toks;
}

// Two merchants are "the same" for rename-propagation if they share a brand-head
// token and one's tokens fully contain the other's — so "Sonic", "Sonic Drive In
// #1717 Chanute Ks" and "Sonic Drive In #2283 Mo" all match despite different
// store numbers / cities / states.
function similarMerchant(a: string, b: string): boolean {
  const ta = merchantTokens(a), tb = merchantTokens(b);
  if (!ta.length || !tb.length || ta[0] !== tb[0]) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => big.includes(t));
}

// Transactions that look like the SAME merchant as `merchant`. A row matches if
// EITHER it shares the original's brand tokens (so store numbers, cities, states
// and other import noise don't matter) OR — when renaming — its merchant text
// contains the new name as a whole word (so renaming a charge to "Sonic" finds
// every "...Sonic Drive In..." too). Used to offer applying a merchant/category
// edit to the lookalikes. Rows already named exactly the new name are excluded.
transactions.post(
  '/similar',
  ah(async (req, res) => {
    const bookId = hh(req);
    const merchant = String(req.body?.merchant ?? '').trim();
    const excludeId = req.body?.exclude_id != null ? Number(req.body.exclude_id) : null;
    const newMerchant = req.body?.new_merchant != null ? String(req.body.new_merchant).trim().toLowerCase() : null;
    const newTokens = newMerchant ? merchantTokens(newMerchant) : [];
    if (!merchantTokens(merchant).length && !newTokens.length) return res.json({ transactions: [] });

    const rows = await query<any>(
      `SELECT t.id, t.merchant, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.direction,
              t.category_id, c.name AS category_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.book_id = $1 AND t.merchant IS NOT NULL AND btrim(t.merchant) <> ''
        ORDER BY t.txn_date DESC NULLS LAST, t.id DESC
        LIMIT 5000`,
      [bookId]
    );
    const matches = rows.filter((r) => {
      if (r.id === excludeId) return false;
      const ml = (r.merchant ?? '').trim().toLowerCase();
      if (newMerchant && ml === newMerchant) return false; // already named exactly that
      if (similarMerchant(merchant, r.merchant)) return true;
      // Contains the new name as a whole word (token containment).
      if (newTokens.length) {
        const mt = merchantTokens(r.merchant);
        if (newTokens.every((t) => mt.includes(t))) return true;
      }
      return false;
    });
    res.json({ transactions: matches.slice(0, 500) });
  })
);

// Apply a merchant rename and/or category to many transactions at once.
transactions.post(
  '/bulk-update',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    if (!ids.length) return res.json({ updated: 0 });

    const sets: string[] = [];
    const params: any[] = [bookId, ids];
    if (typeof req.body.merchant === 'string') { params.push(req.body.merchant.trim() || null); sets.push(`merchant = $${params.length}`); }
    if ('category_id' in req.body) {
      // Validate the category belongs to the book (null clears it).
      const cat = req.body.category_id;
      if (cat != null && !(await one(`SELECT 1 FROM categories WHERE id = $1 AND book_id = $2`, [cat, bookId]))) {
        throw new HttpError(400, 'Category not found in this book.');
      }
      params.push(cat != null ? Number(cat) : null); sets.push(`category_id = $${params.length}`);
    }
    if (!sets.length) return res.json({ updated: 0 });

    const updated = await query<{ id: number }>(
      `UPDATE transactions SET ${sets.join(', ')} WHERE book_id = $1 AND id = ANY($2) RETURNING id`,
      params
    );
    res.json({ updated: updated.length });
  })
);

// Replace the line_tags for one owner (a transaction or a split) with `tags`.
async function saveLineTags(
  client: any,
  owner: { transaction_id?: number; split_id?: number },
  tags: any[] | undefined,
  bookId: number
) {
  if (tags === undefined) return;
  if (owner.transaction_id != null) await client.query(`DELETE FROM line_tags WHERE transaction_id = $1 AND book_id = $2`, [owner.transaction_id, bookId]);
  else await client.query(`DELETE FROM line_tags WHERE split_id = $1 AND book_id = $2`, [owner.split_id, bookId]);
  for (const t of tags) {
    if (!t || !TAG_KINDS.includes(t.kind) || t.ref_id == null || t.ref_id === '') continue;
    const refId = Number(t.ref_id);
    await assertTagRefOwned(t.kind, refId, bookId);
    await client.query(
      `INSERT INTO line_tags (transaction_id, split_id, kind, ref_id, book_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [owner.transaction_id ?? null, owner.split_id ?? null, t.kind, refId, bookId]
    );
  }
}

// Replace a transaction's splits (delete + reinsert), each with its own tags.
// Deleting the split rows cascades their line_tags away.
async function saveSplits(client: any, txnId: number, splits: any[] | undefined, bookId: number) {
  if (splits === undefined) return;
  await client.query(`DELETE FROM transaction_splits WHERE transaction_id = $1 AND book_id = $2`, [txnId, bookId]);
  for (const s of splits) {
    if (s.amount == null || s.amount === '') continue;
    const amount = money(s.amount, 'split amount');
    await ownedRef('category', s.category_id ?? null, bookId, 'split category_id');
    const row = (await client.query(
      `INSERT INTO transaction_splits (transaction_id, amount, category_id, notes, is_principal, book_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [txnId, amount, s.category_id ?? null, s.notes ?? null, s.is_principal ?? false, bookId]
    )).rows[0];
    await saveLineTags(client, { split_id: row.id }, s.tags ?? [], bookId);
  }
}

// Persist tags + splits consistently: if real splits were supplied, the tags
// live on the splits (clear transaction-level tags); otherwise tags live on the
// transaction and any existing splits are removed.
async function saveTagsAndSplits(client: any, txnId: number, body: any, bookId: number, txnAmount: number) {
  const splits = Array.isArray(body.splits)
    ? body.splits.filter((s: any) => s.amount !== '' && s.amount != null)
    : [];
  if (splits.length) {
    // A breakdown must account for the whole transaction (cent tolerance for rounding).
    assertSplitTotal(splits.map((s: any) => money(s.amount, 'split amount')), txnAmount);
    await saveSplits(client, txnId, splits, bookId);
    await saveLineTags(client, { transaction_id: txnId }, [], bookId);
  } else {
    await saveSplits(client, txnId, [], bookId);
    await saveLineTags(client, { transaction_id: txnId }, body.tags ?? [], bookId);
  }
}

// Create one transaction (validating refs, splits/tags, and the subscription +
// utility-invoice side effects) on an existing client/transaction. Shared by the
// POST route and the CSV import confirm flow so both behave identically.
export async function insertTransaction(client: any, bookId: number, b: any) {
  await assertRefsOwned(client, bookId, b);
  const posted_date = 'posted_date' in b ? b.posted_date : (b.txn_date ?? new Date().toISOString().slice(0, 10));
  // A transfer is one row (source account_id + destination transfer_account_id);
  // transfer_group_id is an explicit linkage key for reconciliation / import
  // matching (a counterpart imported entry can later share the same group).
  const direction = b.direction ?? 'expense';
  const transfer_group_id = b.transfer_group_id ?? (direction === 'transfer' ? `tg-${randomUUID()}` : null);
  const r = (await client.query(
    `INSERT INTO transactions
      (account_id, category_id, transfer_account_id, txn_date, posted_date, amount, direction, merchant, description, purchaser, channel, book_id, principal_amount, interest_category_id, transfer_group_id, source, external_id)
     VALUES ($1,$2,$3, COALESCE($4, CURRENT_DATE), $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [
      b.account_id ?? null, b.category_id ?? null, b.transfer_account_id ?? null, b.txn_date ?? null,
      posted_date ?? null, b.amount, direction, b.merchant ?? null, b.description ?? null,
      b.purchaser ?? null, b.channel ?? null, bookId,
      b.principal_amount ?? null, b.interest_category_id ?? null, transfer_group_id,
      // Carry provider provenance through to the ledger so dedup + auditing work.
      b.source ?? null, b.external_id ?? null,
    ]
  )).rows[0];
  await saveTagsAndSplits(client, r.id, b, bookId, Number(r.amount));
  // Entering an expense for a subscription advances its next due date.
  if (r.direction === 'expense') {
    await advanceSubscriptionDueDates(client, await subscriptionIdsForTransaction(client, r.id), bookId);
  }
  // Apply (or clear) any utility-invoice payment this transaction represents.
  await applyTransactionToInvoices(client, r.id, bookId);
  return r;
}

transactions.post(
  '/',
  ah(async (req, res) => {
    validateTxnValues(req.body ?? {}, true);
    const bookId = hh(req);
    const row = await withTransaction((client) => insertTransaction(client, bookId, req.body));
    res.status(201).json(row);
  })
);

transactions.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body ?? {};
    validateTxnValues(b, false);
    const bookId = hh(req);
    const row = await withTransaction(async (client) => {
      await assertRefsOwned(client, bookId, b);
      // Capture existing subscription associations before this edit changes them.
      const oldSubs = await subscriptionIdsForTransaction(client, Number(req.params.id));
      const r = (await client.query(
        `UPDATE transactions SET
           account_id = $2, category_id = $3, transfer_account_id = $4,
           txn_date = COALESCE($5, txn_date), posted_date = $6, amount = COALESCE($7, amount),
           direction = COALESCE($8, direction), merchant = $9, description = $10, purchaser = $11, channel = $12,
           principal_amount = $14, interest_category_id = $15
         WHERE id = $1 AND book_id = $13 RETURNING *`,
        [
          req.params.id, b.account_id ?? null, b.category_id ?? null, b.transfer_account_id ?? null,
          b.txn_date ?? null, b.posted_date ?? null, b.amount ?? null,
          b.direction ?? null, b.merchant ?? null, b.description ?? null, b.purchaser ?? null, b.channel ?? null,
          bookId,
          b.principal_amount ?? null, b.interest_category_id ?? null,
        ]
      )).rows[0];
      if (!r) throw new HttpError(404, 'Transaction not found');
      // Ensure a transfer always carries an explicit linkage group id (e.g. when a
      // plain transaction is edited into a transfer). Existing groups are kept.
      if (r.direction === 'transfer' && !r.transfer_group_id) {
        r.transfer_group_id = b.transfer_group_id ?? `tg-${randomUUID()}`;
        await client.query(`UPDATE transactions SET transfer_group_id = $2 WHERE id = $1`, [r.id, r.transfer_group_id]);
      }
      await saveTagsAndSplits(client, r.id, b, bookId, Number(r.amount));
      // Advance only for subscriptions newly associated by this edit.
      if (r.direction === 'expense') {
        const added = (await subscriptionIdsForTransaction(client, r.id)).filter((id) => !oldSubs.includes(id));
        await advanceSubscriptionDueDates(client, added, bookId);
      }
      // Re-derive any utility-invoice payment this transaction represents (the
      // call clears its prior payments first, so removing the category reopens).
      await applyTransactionToInvoices(client, r.id, bookId);
      return r;
    });
    res.json(row);
  })
);

// Lightweight category change (used by the budget transaction popups). Sets the
// transaction's top-level category and re-runs the subscription/utility hooks.
transactions.post(
  '/:id/category',
  ah(async (req, res) => {
    const categoryId = req.body?.category_id ?? null;
    const bookId = hh(req);
    const row = await withTransaction(async (client) => {
      await assertRefsOwned(client, bookId, { category_id: categoryId });
      const r = (await client.query(`UPDATE transactions SET category_id = $2 WHERE id = $1 AND book_id = $3 RETURNING *`, [req.params.id, categoryId, bookId])).rows[0];
      if (!r) throw new HttpError(404, 'Transaction not found');
      // NOTE: this endpoint only changes the category, never the subscription tags, so
      // it must NOT advance subscription due dates — doing so unconditionally drifted
      // next_due_date forward on every call (and on double-click). Tag-driven advancing
      // happens in PUT (for newly-added subs only). Re-derive utility-invoice payments
      // though: that IS category-driven and is idempotent (clears + re-applies).
      await applyTransactionToInvoices(client, r.id, bookId);
      return r;
    });
    res.json(row);
  })
);

// Mark a pending transaction posted on a date, or back to pending ({ posted: false }).
// Without a date it posts on the transaction's own date, never "today": catching up on
// transactions that cleared days ago would otherwise stamp the wrong posting date,
// which moves balances across snapshot cutoffs.
transactions.post(
  '/:id/post',
  ah(async (req, res) => {
    const unpost = req.body?.posted === false;
    const date = unpost ? null : optionalDateOnly(req.body?.posted_date, 'posted_date');
    const row = await one(
      `UPDATE transactions SET posted_date = CASE WHEN $4 THEN NULL ELSE COALESCE($2::date, txn_date) END
        WHERE id = $1 AND book_id = $3 RETURNING *`,
      [req.params.id, date, hh(req), unpost]
    );
    if (!row) throw new HttpError(404, 'Transaction not found');
    res.json(row);
  })
);

transactions.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    await withTransaction(async (client) => {
      // Capture invoices this transaction paid; deleting it cascades the payment
      // rows away, after which we re-derive each invoice's paid state.
      const affected = (await client.query(`SELECT DISTINCT invoice_id FROM utility_invoice_payments WHERE transaction_id = $1 AND book_id = $2`, [req.params.id, bookId])).rows.map((x: any) => Number(x.invoice_id));
      await client.query(`DELETE FROM transactions WHERE id = $1 AND book_id = $2`, [req.params.id, bookId]);
      for (const id of affected) await recomputeInvoicePaid(client, id, bookId);
    });
    res.status(204).end();
  })
);

// --- Transfer finder over POSTED transactions ------------------------------
// Two posted transactions that look like the two halves of one transfer (opposite
// direction, equal amount, two different accounts, within a few days) are surfaced as
// suggestions — catching transfers entered manually or already posted as two separate
// rows. Computed on demand, like the subscription suggestion finder.
const TRANSFER_SUGGEST_DAYS = 4;

async function detectTransferSuggestions(bookId: number) {
  const rows = await query<any>(
    `SELECT e.id AS out_id, e.account_id AS out_account_id, ea.name AS out_account_name,
            to_char(e.txn_date,'YYYY-MM-DD') AS out_date, e.merchant AS out_merchant,
            i.id AS in_id, i.account_id AS in_account_id, ia.name AS in_account_name,
            to_char(i.txn_date,'YYYY-MM-DD') AS in_date, i.merchant AS in_merchant,
            e.amount::float8 AS amount
       FROM transactions e
       JOIN transactions i
         ON i.book_id = e.book_id AND i.direction = 'income'
        AND i.account_id <> e.account_id AND i.amount = e.amount
        AND i.txn_date BETWEEN e.txn_date - ${TRANSFER_SUGGEST_DAYS} AND e.txn_date + ${TRANSFER_SUGGEST_DAYS}
       JOIN accounts ea ON ea.id = e.account_id
       JOIN accounts ia ON ia.id = i.account_id
      WHERE e.book_id = $1 AND e.direction = 'expense'
        AND e.txn_date >= CURRENT_DATE - INTERVAL '365 days'
        AND NOT EXISTS (
          SELECT 1 FROM dismissed_transfer_suggestions d
           WHERE d.book_id = $1 AND d.txn_a = LEAST(e.id, i.id) AND d.txn_b = GREATEST(e.id, i.id))
      ORDER BY e.amount DESC, e.txn_date DESC
      LIMIT 200`,
    [bookId]
  );
  // Greedy 1:1 pairing so no transaction is offered in two suggestions.
  const used = new Set<number>();
  const out: any[] = [];
  for (const r of rows) {
    if (used.has(r.out_id) || used.has(r.in_id)) continue;
    used.add(r.out_id); used.add(r.in_id);
    out.push({
      key: `${Math.min(r.out_id, r.in_id)}-${Math.max(r.out_id, r.in_id)}`,
      amount: r.amount,
      out: { id: r.out_id, account_id: r.out_account_id, account_name: r.out_account_name, date: r.out_date, merchant: r.out_merchant },
      in: { id: r.in_id, account_id: r.in_account_id, account_name: r.in_account_name, date: r.in_date, merchant: r.in_merchant },
    });
  }
  // Oldest pair first, newest last (by the earlier of the two transaction dates).
  out.sort((a, b) => Math.min(Date.parse(a.out.date), Date.parse(a.in.date)) - Math.min(Date.parse(b.out.date), Date.parse(b.in.date)));
  return out;
}

transactions.get('/transfer-suggestions', ah(async (req, res) => {
  res.json(await detectTransferSuggestions(hh(req)));
}));

// Delete a posted transaction the same way DELETE /:id does (cascade splits/tags, then
// re-derive any utility invoices it paid).
// Returns whether the transaction existed (and was deleted).
async function deletePostedTxn(client: any, bookId: number, id: number): Promise<boolean> {
  const affected = (await client.query(`SELECT DISTINCT invoice_id FROM utility_invoice_payments WHERE transaction_id = $1 AND book_id = $2`, [id, bookId])).rows.map((x: any) => Number(x.invoice_id));
  const del = await client.query(`DELETE FROM transactions WHERE id = $1 AND book_id = $2`, [id, bookId]);
  for (const inv of affected) await recomputeInvoicePaid(client, inv, bookId);
  return del.rowCount === 1;
}

// Replace two posted transactions with one transfer.
transactions.post('/transfer-suggestions/confirm', ah(async (req, res) => {
  const bookId = hh(req);
  const outId = Number(req.body?.out_id);
  const inId = Number(req.body?.in_id);
  if (!Number.isInteger(outId) || !Number.isInteger(inId) || outId === inId) throw new HttpError(400, 'Two different transactions are required.');
  const created = await withTransaction(async (client) => {
    // Lock both rows (in id order, so two requests can't deadlock) before validating.
    // A concurrent confirmation of the same pair, or of a pair sharing one of these
    // transactions, waits here; once the first commits, the rows are gone and this
    // one gets a conflict instead of creating a second transfer.
    const rows = (await client.query(
      `SELECT * FROM transactions WHERE id = ANY($1::int[]) AND book_id = $2 ORDER BY id FOR UPDATE`,
      [[outId, inId], bookId]
    )).rows;
    const a = rows.find((r: any) => r.id === outId);
    const b = rows.find((r: any) => r.id === inId);
    if (!a || !b) throw new HttpError(409, 'One of these transactions no longer exists. It may already have been converted to a transfer.');
    if (a.account_id === b.account_id) throw new HttpError(400, 'A transfer must be between two different accounts.');
    if (Number(a.amount) !== Number(b.amount)) throw new HttpError(400, 'These transactions are not the same amount.');
    const src = a.direction === 'expense' ? a : b;
    const dst = a.direction === 'expense' ? b : a;
    if (src.direction !== 'expense' || dst.direction !== 'income') throw new HttpError(400, 'A transfer needs one expense and one income.');
    // Carry the expense's provenance onto the transfer; record the income's provider id
    // so neither side re-imports later.
    const removed = (await deletePostedTxn(client, bookId, src.id)) && (await deletePostedTxn(client, bookId, dst.id));
    if (!removed) throw new HttpError(409, 'These transactions changed while converting them. Refresh and try again.');
    const transfer = await insertTransaction(client, bookId, {
      account_id: src.account_id, transfer_account_id: dst.account_id, direction: 'transfer',
      amount: src.amount, txn_date: src.txn_date, posted_date: src.posted_date ?? src.txn_date,
      merchant: src.merchant || dst.merchant, description: src.description || dst.description,
      source: src.source, external_id: src.external_id,
    });
    if (dst.external_id) {
      await client.query(
        `INSERT INTO consumed_external_ids (book_id, transaction_id, source, external_id)
              VALUES ($1, $2, $3, $4) ON CONFLICT (book_id, source, external_id) DO NOTHING`,
        [bookId, transfer.id, dst.source ?? 'simplefin', dst.external_id]
      );
    }
    return transfer;
  });
  res.status(201).json(created);
}));

transactions.post('/transfer-suggestions/ignore', ah(async (req, res) => {
  const bookId = hh(req);
  const outId = Number(req.body?.out_id);
  const inId = Number(req.body?.in_id);
  if (!Number.isInteger(outId) || !Number.isInteger(inId) || outId === inId) throw new HttpError(400, 'Two transactions are required.');
  const lo = Math.min(outId, inId);
  const hiId = Math.max(outId, inId);
  await query(
    `INSERT INTO dismissed_transfer_suggestions (book_id, txn_a, txn_b)
          VALUES ($1, $2, $3) ON CONFLICT (book_id, txn_a, txn_b) DO NOTHING`,
    [bookId, lo, hiId]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Receipt parsing: extract itemized data from an uploaded receipt image via AI.
// Stateless — the image is held client-side until the transaction is saved.
// ---------------------------------------------------------------------------
// Controlled top-level taxonomy for receipt items. Keep in sync with the web copy in
// web/src/pages/transactions/helpers.ts (ITEM_CATEGORIES).
export const ITEM_CATEGORIES = [
  'Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Pantry & Dry Goods', 'Snacks',
  'Beverages', 'Frozen', 'Candy & Sweets', 'Book & Cleaning', 'Personal Care & Health',
  'Baby & Kids', 'Pet', 'Alcohol', 'Other',
];
const CATEGORY_BY_LOWER = new Map(ITEM_CATEGORIES.map((c) => [c.toLowerCase(), c]));
// Snap an arbitrary string to a canonical taxonomy value (unknown → "Other", blank → null).
const normalizeCategory = (v: any): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return CATEGORY_BY_LOWER.get(s.toLowerCase()) ?? 'Other';
};
// Lenient parse for AI-extracted previews: silently drops non-numeric noise (the shared
// optionalNumber from validation.js throws a 400 — use that on the write path instead).
const looseNumber = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const RECEIPT_PROMPT = `This is a photo of a purchase receipt. Extract its contents as JSON with exactly this shape:
{
  "merchant": string | null,
  "purchased_at": "YYYY-MM-DD" | null,
  "subtotal": number | null,
  "tax": number | null,
  "total": number | null,
  "items": [{
    "name": string,
    "brand": string | null,
    "category": one of ${JSON.stringify(ITEM_CATEGORIES)},
    "size": number | null,
    "unit": string | null,
    "product_category": string | null,
    "quantity": number,
    "unit_price": number | null,
    "total_price": number | null
  }]
}
Rules:
- Use plain numbers (no currency symbols).
- "category" MUST be exactly one of the listed values (best fit; use "Other" if none fit).
- "brand" is the manufacturer/brand from the item text (e.g. "Great Value", "Starbucks"), or null for unbranded items.
- "size" is the numeric package size and "unit" its measure ("oz", "fl oz", "lb", "ct", "gal", "ea"). From "Greek Yogurt, 32 oz" → size 32, unit "oz". From "Dinner Rolls, 12 Count" → size 12, unit "ct".
- "product_category" is a short specific descriptor (e.g. "greek yogurt", "sliced cheese").
- If a field is unreadable use null. Return ONLY the JSON object, no prose, no code fences.`;

function parseJsonLoose(text: string): any {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function parseJsonArrayLoose(text: string): any {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// Backfill/enrich: derive brand, category, size, unit from item NAMES alone (text-only,
// no image). Used to fill structured attributes on items that were entered or imported
// before those fields existed. Stateless — returns suggestions in input order.
const ENRICH_PROMPT = `You are given a JSON array of store line-item descriptions. Return a JSON array of the SAME length and order. Each element:
{ "brand": string | null, "category": one of ${JSON.stringify(ITEM_CATEGORIES)}, "size": number | null, "unit": string | null }
Rules: "category" MUST be exactly one listed value (best fit, "Other" if none). "brand" = manufacturer/brand from the text (e.g. "Great Value") or null. "size"+"unit" from the text ("32 oz" → 32,"oz"; "12 Count" → 12,"ct"). Return ONLY the JSON array, no prose, no code fences.`;

transactions.post(
  '/enrich-items',
  ah(async (req, res) => {
    const names = Array.isArray(req.body?.items)
      ? req.body.items.map((x: any) => String(x?.name ?? '').slice(0, 300)).filter(Boolean)
      : [];
    if (!names.length) return res.json({ items: [] });
    try {
      const text = await ask(`${ENRICH_PROMPT}\n\nItems:\n${JSON.stringify(names)}`, { maxTokens: 3000 });
      let arr: any;
      try { arr = parseJsonArrayLoose(text); }
      catch { throw new HttpError(502, 'Could not read the AI response — it was not valid JSON.'); }
      const out = (Array.isArray(arr) ? arr : []).map((it: any) => ({
        brand: it?.brand ?? null, category: normalizeCategory(it?.category),
        size: looseNumber(it?.size), unit: it?.unit ?? null,
      }));
      res.json({ items: out });
    } catch (e) {
      if (e instanceof AiNotConfiguredError) throw new HttpError(503, e.message);
      throw e;
    }
  })
);

transactions.post(
  '/parse-receipt',
  ah(async (req, res) => {
    const { image, mime } = req.body ?? {};
    if (!image) throw new HttpError(400, 'No image provided.');
    try {
      const text = await askVision([{ data: image, mime: mime || 'image/jpeg' }], RECEIPT_PROMPT);
      let parsed: any;
      try { parsed = parseJsonLoose(text); }
      catch { throw new HttpError(502, 'Could not read the receipt — the AI response was not valid JSON. You can enter the items manually.'); }
      res.json(parsed);
    } catch (e) {
      if (e instanceof AiNotConfiguredError) throw new HttpError(503, e.message);
      throw e;
    }
  })
);

// ---------------------------------------------------------------------------
// Receipt for a transaction (header + image + itemized products)
// ---------------------------------------------------------------------------
transactions.get(
  '/:id/receipt',
  ah(async (req, res) => {
    await ownedTxn(req);
    const receipt = await one(
      `SELECT id, transaction_id, merchant, purchased_at, subtotal, tax, total, raw_text, notes,
              image_mime, original_name, (image IS NOT NULL) AS has_image
       FROM receipts WHERE transaction_id = $1`,
      [req.params.id]
    );
    if (!receipt) return res.json(null);
    const items = await query(
      `SELECT * FROM receipt_items WHERE receipt_id = $1 ORDER BY id`,
      [(receipt as any).id]
    );
    res.json({ ...receipt, items });
  })
);

// Stream the stored receipt file (image or PDF) for inline viewing.
transactions.get(
  '/:id/receipt/image',
  ah(async (req, res) => {
    await ownedTxn(req);
    const r = await one<any>(`SELECT image, image_mime, original_name FROM receipts WHERE transaction_id = $1`, [req.params.id]);
    if (!r || !r.image) throw new HttpError(404, 'No receipt file.');
    sendStoredFile(res, r.image, r.image_mime, r.original_name);
  })
);

// Upsert the receipt (optionally with an image) and replace its line items.
transactions.put(
  '/:id/receipt',
  ah(async (req, res) => {
    const txnId = await ownedTxn(req);
    const bookId = hh(req);
    const {
      merchant = null, purchased_at = null, subtotal = null, tax = null, total = null,
      raw_text = null, notes = null, items = [], image = null, image_mime = null, original_name = null,
    } = req.body;
    optionalDateOnly(purchased_at, 'purchased_at');
    optionalMoney(subtotal, 'subtotal');
    optionalMoney(tax, 'tax');
    optionalMoney(total, 'total');
    // Bound free-text fields — these may be AI-extracted from a receipt photo.
    const merchantC = clampText(merchant, 200);
    const notesC = clampText(notes, 2000);
    const rawTextC = clampText(raw_text, 20000);
    const imageBuf = image ? Buffer.from(image, 'base64') : null;
    // Reject anything but the allowed image/PDF types before it's stored — the
    // file is later streamed back inline, so untrusted MIME types are an XSS risk.
    const safeImageMime = image ? assertUploadMime(image_mime) : null;
    assertUploadSize(image);

    const receiptId = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO receipts (transaction_id, merchant, purchased_at, subtotal, tax, total, raw_text, notes, image, image_mime, original_name, book_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (transaction_id) DO UPDATE SET
           merchant = EXCLUDED.merchant, purchased_at = EXCLUDED.purchased_at,
           subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax, total = EXCLUDED.total,
           raw_text = EXCLUDED.raw_text, notes = EXCLUDED.notes,
           image = COALESCE(EXCLUDED.image, receipts.image),
           image_mime = COALESCE(EXCLUDED.image_mime, receipts.image_mime),
           original_name = COALESCE(EXCLUDED.original_name, receipts.original_name)
         RETURNING id`,
        [txnId, merchantC, purchased_at, subtotal, tax, total, rawTextC, notesC, imageBuf, safeImageMime, original_name, bookId]
      );
      const rid = r.rows[0].id;

      await client.query(`DELETE FROM receipt_items WHERE receipt_id = $1`, [rid]);
      for (const it of items as any[]) {
        const name = clampText(it.name, 300);
        if (!name) continue;
        // Item numerics may also be AI-extracted — validate finiteness before insert.
        const quantity = it.quantity == null || it.quantity === '' ? 1 : numberValue(it.quantity, 'item quantity'); // NUMERIC(14,3)
        const unit_price = optionalNumber(it.unit_price, 'item unit_price'); // NUMERIC(16,4): per-unit price, finer than cents
        const total_price = optionalMoney(it.total_price, 'item total_price');
        const sizeN = optionalNumber(it.size, 'item size');
        // Price per single unit-of-measure (e.g. $/oz), for cross-product price comparison.
        const uomPrice = total_price != null && sizeN && sizeN > 0 && quantity > 0
          ? Math.round((total_price / (quantity * sizeN)) * 10000) / 10000 : null;
        await client.query(
          `INSERT INTO receipt_items (receipt_id, name, brand, category, product_category, quantity, unit_price, total_price, size, unit, uom_price, book_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [rid, name, clampText(it.brand, 100), normalizeCategory(it.category), clampText(it.product_category, 100),
           quantity, unit_price, total_price, sizeN, clampText(it.unit, 24), uomPrice, bookId]
        );
      }
      return rid;
    });

    const saved = await query(`SELECT * FROM receipt_items WHERE receipt_id = $1 ORDER BY id`, [receiptId]);
    const head = await one(
      `SELECT id, transaction_id, merchant, purchased_at, subtotal, tax, total, raw_text, notes,
              image_mime, original_name, (image IS NOT NULL) AS has_image
       FROM receipts WHERE id = $1`,
      [receiptId]
    );
    res.json({ ...(head as any), items: saved });
  })
);
