import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import {
  requiredString, money, optionalMoney, optionalEnumValue, optionalDateOnly, ownedRef,
  SUBSCRIPTION_BILLING_CYCLES, SUBSCRIPTION_STATUSES,
} from '../validation.js';

// Confirm a subscription belongs to the active book, or 404.
async function ownedSubscription(req: any): Promise<number> {
  const s = await one<{ id: number }>(`SELECT id FROM subscriptions WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!s) throw new HttpError(404, 'Subscription not found');
  return s.id;
}

// Append a price-history entry (snapshot pattern) so plan price changes are tracked.
async function recordSubscriptionPrice(sub: any, bookId: number, effectiveDate?: string | null): Promise<void> {
  await query(
    `INSERT INTO subscription_price_history (subscription_id, book_id, amount, billing_cycle, effective_date)
     VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE))`,
    [sub.id, bookId, sub.amount, sub.billing_cycle, effectiveDate ?? null]
  );
}

// Validate a subscription body's value fields + cross-book references.
async function validateSubscription(b: any, bookId: number, amountRequired: boolean): Promise<void> {
  if (amountRequired) money(b.amount, 'amount', { min: 0 }); else optionalMoney(b.amount, 'amount', { min: 0 });
  optionalEnumValue(b.billing_cycle, 'billing_cycle', SUBSCRIPTION_BILLING_CYCLES);
  optionalEnumValue(b.status, 'status', SUBSCRIPTION_STATUSES);
  optionalDateOnly(b.next_due_date, 'next_due_date');
  optionalDateOnly(b.start_date, 'start_date');
  optionalDateOnly(b.end_date, 'end_date');
  await ownedRef('account', b.account_id, bookId, 'account_id');
  await ownedRef('category', b.category_id, bookId, 'category_id');
}

export const subscriptions = Router();

// Normalize any billing cycle to a per-month cost so totals are comparable.
const MONTHLY_FACTOR: Record<string, number> = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};
// Billing cycles per year. Yearly cost is derived from the raw amount, never from
// the rounded monthly figure: $139/yr is 11.58/mo, but 11.58 × 12 is 138.96.
const YEARLY_FACTOR: Record<string, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const rawMonthly = (amount: number, cycle: string) => amount * (MONTHLY_FACTOR[cycle] ?? 1);
const rawYearly = (amount: number, cycle: string) => amount * (YEARLY_FACTOR[cycle] ?? 12);
const monthlyAmount = (amount: number, cycle: string) => round2(rawMonthly(amount, cycle));
const yearlyAmount = (amount: number, cycle: string) => round2(rawYearly(amount, cycle));

// Fixed interval per cycle for advancing the renewal date (not user input).
const CYCLE_INTERVAL: Record<string, string> = {
  weekly: '7 days',
  monthly: '1 month',
  quarterly: '3 months',
  yearly: '1 year',
};

const withDerived = (row: any) => ({
  ...row,
  monthly_amount: monthlyAmount(Number(row.amount), row.billing_cycle),
  yearly_amount: yearlyAmount(Number(row.amount), row.billing_cycle),
});

// ---------------------------------------------------------------------------
// Subscription detection: scan a book's expense transactions for a
// merchant that charges a consistent amount on a regular cadence — the
// signature of a recurring subscription. Conservative on purpose (>=3 charges,
// stable amount, regular interval) so we only surface high-confidence guesses.
// Already-tracked subscriptions and user-ignored merchants are excluded.
type DetectedCycle = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
const CYCLE_DAYS: [DetectedCycle, number][] = [
  ['weekly', 7],
  ['monthly', 30],
  ['quarterly', 91],
  ['yearly', 365],
];

// How far two charges can differ and still count as "the same amount" — tight,
// so a steady subscription qualifies but a drifting utility bill does not.
const AMOUNT_TOL = 0.5;

const median = (nums: number[]) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Map a typical gap-in-days to a known billing cycle, or null if it fits none.
const classifyCycle = (medianGap: number): DetectedCycle | null => {
  for (const [cycle, days] of CYCLE_DAYS) {
    if (Math.abs(medianGap - days) <= days * 0.35 + 3) return cycle;
  }
  return null;
};

// Advance a YYYY-MM-DD date by one billing cycle (calendar-aware), in UTC.
const advanceDate = (isoDate: string, cycle: DetectedCycle): string => {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (cycle === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (cycle === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cycle === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};

// Normalize a raw bank descriptor to a stable key for recurring-charge
// grouping. Bank statements often embed a per-charge date/time, card mask, and
// reference number in the merchant text (e.g. "Purchase Openai *chatgpt Subscr
// Openai.com Ca *****2649 05/23 17:04"), which would otherwise put every charge
// of the same subscription into its own group. Stripping that noise lets them
// collapse together. Keep this in sync with the copy in web/.../Transactions.tsx.
export function recurringKey(merchant: string): string {
  let s = (merchant ?? '').toLowerCase();
  s = s.replace(/[*x#]{2,}\s*\d+/g, ' ');                  // masked card/acct: *****2649, xxxx1234
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' '); // dates MM/DD[/YY]
  s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');       // times HH:MM[:SS]
  s = s.replace(/\b\d{3,}\b/g, ' ');                       // long store/ref numbers
  s = s.replace(/^\s*(purchase|pos debit|pos|debit card|ach|sq|tst|sp|pp|paypal|recurring)\b/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();                // collapse punctuation & whitespace
  return s.replace(/\s+/g, ' ');
}

const titleCase = (s: string): string =>
  s.split(' ').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

interface SuggestionTxn { id: number; date: string; amount: number; merchant: string }
interface SubscriptionSuggestion {
  merchant: string;
  key: string;
  amount: number;
  billing_cycle: DetectedCycle;
  count: number;
  last_date: string;
  next_due_date: string;
  interval_days: number;
  transactions: SuggestionTxn[];
}

async function detectSuggestions(bookId: number): Promise<SubscriptionSuggestion[]> {
  const txns = await query<{ id: number; amount: any; date: string; merchant: string }>(
    `SELECT t.id, t.amount, to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.merchant
       FROM transactions t
      WHERE t.book_id = $1 AND t.direction = 'expense'
        AND t.merchant IS NOT NULL AND btrim(t.merchant) <> '' AND t.txn_date IS NOT NULL
        -- Skip transactions already tagged to a subscription (on the transaction or
        -- any split) — they're already tracked, so don't re-suggest them.
        AND NOT EXISTS (
          SELECT 1 FROM line_tags lt
          LEFT JOIN transaction_splits s ON s.id = lt.split_id
          WHERE lt.kind = 'subscription'
            AND COALESCE(s.transaction_id, lt.transaction_id) = t.id
        )
      ORDER BY t.txn_date`,
    [bookId]
  );
  if (!txns.length) return [];

  // Group on the normalized key so a recurring charge collapses even when the
  // bank descriptor varies per charge (embedded dates, ref numbers, etc.).
  const groups = new Map<string, { display: string; amounts: number[]; dates: string[]; txns: SuggestionTxn[] }>();
  for (const t of txns) {
    const key = recurringKey(t.merchant);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = { display: titleCase(key), amounts: [], dates: [], txns: [] }; groups.set(key, g); }
    g.txns.push({ id: t.id, date: t.date, amount: Number(t.amount), merchant: t.merchant });
    g.amounts.push(Number(t.amount));
    g.dates.push(t.date);
  }

  const existing = await query<{ name: string; merchant_key: string | null }>(
    `SELECT name, merchant_key FROM subscriptions WHERE book_id = $1`,
    [bookId]
  );
  const ignored = await query<{ merchant: string }>(
    `SELECT merchant FROM ignored_subscription_merchants WHERE book_id = $1`,
    [bookId]
  );
  // Compare on the normalized key so an already-tracked/ignored merchant is
  // matched regardless of descriptor noise. A subscription's stored merchant_key
  // matches its charges even after it's been renamed away from the merchant text.
  const skip = new Set<string>();
  for (const r of existing) {
    skip.add(recurringKey(r.name));
    if (r.merchant_key) skip.add(r.merchant_key);
  }
  for (const r of ignored) skip.add(recurringKey(r.merchant));

  const out: SubscriptionSuggestion[] = [];
  for (const [key, g] of groups) {
    if (skip.has(key)) continue;
    if (g.amounts.length < 3) continue;

    // Same-amount focus: a real subscription bills (essentially) the SAME amount
    // each period. Find the largest cluster of charges sharing one amount (to the
    // cent, within a few cents for tax/FX jitter). A utility bill drifts dollar to
    // dollar, so it never forms a big enough cluster and won't be flagged.
    const n = g.amounts.length;
    let clusterIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (g.amounts[i] <= 0) continue;
      const idxs: number[] = [];
      for (let j = 0; j < n; j++) if (Math.abs(g.amounts[j] - g.amounts[i]) <= AMOUNT_TOL) idxs.push(j);
      if (idxs.length > clusterIdx.length) clusterIdx = idxs;
    }
    // Need at least 3 charges at the same amount, and they must be the majority.
    if (clusterIdx.length < 3 || clusterIdx.length / n < 0.6) continue;

    const amount = median(clusterIdx.map((i) => g.amounts[i]));
    if (amount <= 0) continue;

    // Interval must be regular among those same-amount charges.
    const epochDays = clusterIdx.map((i) => Math.round(new Date(g.dates[i] + 'T00:00:00Z').getTime() / 86400000)).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < epochDays.length; i++) gaps.push(epochDays[i] - epochDays[i - 1]);
    if (!gaps.length) continue;
    const medGap = median(gaps);
    const cycle = classifyCycle(medGap);
    if (!cycle) continue;
    const regular = gaps.filter((gp) => Math.abs(gp - medGap) <= Math.max(medGap * 0.4, 4)).length;
    if (regular / gaps.length < 0.6) continue;

    const clusterTxns = clusterIdx.map((i) => g.txns[i]);
    const lastDate = clusterTxns[clusterTxns.length - 1].date;
    out.push({
      merchant: g.display,
      key,
      amount: Math.round(amount * 100) / 100,
      billing_cycle: cycle,
      count: clusterTxns.length,
      last_date: lastDate,
      next_due_date: advanceDate(lastDate, cycle),
      interval_days: Math.round(medGap),
      transactions: clusterTxns.slice().reverse(), // most recent first
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// Roll each (non-canceled) subscription's next due date forward by one billing
// cycle. Used when a payment is logged or a transaction is tagged to it. Scoped
// to the book so it can never touch another tenant's rows.
export async function advanceSubscriptionDueDates(client: any, subIds: number[], bookId: number): Promise<void> {
  if (!subIds.length) return;
  await client.query(
    `UPDATE subscriptions
       SET next_due_date = COALESCE(next_due_date, CURRENT_DATE) +
         (CASE billing_cycle
            WHEN 'weekly' THEN INTERVAL '7 days'
            WHEN 'quarterly' THEN INTERVAL '3 months'
            WHEN 'yearly' THEN INTERVAL '1 year'
            ELSE INTERVAL '1 month' END)
     WHERE id = ANY($1) AND status <> 'canceled' AND book_id = $2`,
    [subIds, bookId]
  );
}

subscriptions.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    await sweepDueCancellations(bookId);
    const rows = await query(`
      SELECT s.*, c.name AS category_name, a.name AS account_name,
             COALESCE((SELECT count(*)::int FROM subscription_documents d WHERE d.subscription_id = s.id), 0) AS doc_count
      FROM subscriptions s
      LEFT JOIN categories c ON c.id = s.category_id
      LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.book_id = $1
      ORDER BY (s.status = 'canceled')::int, s.sort_order, lower(s.name)
    `, [bookId]);
    res.json(rows.map(withDerived));
  })
);

// Persist a manual order (drag-to-reorder); ids are the full list in new order.
subscriptions.post(
  '/reorder',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    await withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(`UPDATE subscriptions SET sort_order = $1 WHERE id = $2 AND book_id = $3`, [i, ids[i], bookId]);
      }
    });
    res.json({ ok: true });
  })
);

// Aggregate view: normalized monthly/yearly cost of active subs + upcoming renewals.
subscriptions.get(
  '/summary',
  ah(async (req, res) => {
    const bookId = hh(req);
    await sweepDueCancellations(bookId);
    const active = await query(`SELECT * FROM subscriptions WHERE status = 'active' AND book_id = $1`, [bookId]);
    // Sum unrounded per-item costs and round once, so per-item rounding doesn't accumulate.
    const monthly = active.reduce((s, r: any) => s + rawMonthly(Number(r.amount), r.billing_cycle), 0);
    const yearly = active.reduce((s, r: any) => s + rawYearly(Number(r.amount), r.billing_cycle), 0);

    const upcoming = await query(`
      SELECT s.*, c.name AS category_name, a.name AS account_name
      FROM subscriptions s
      LEFT JOIN categories c ON c.id = s.category_id
      LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.book_id = $1 AND s.status = 'active' AND s.next_due_date IS NOT NULL
        AND s.next_due_date <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY s.next_due_date
    `, [bookId]);

    res.json({
      activeCount: active.length,
      monthlyTotal: round2(monthly),
      yearlyTotal: round2(yearly),
      upcoming: upcoming.map(withDerived),
    });
  })
);

// Every actual charge tied to any subscription via a subscription tag (on the
// transaction itself or a split). The client groups/filters these for details.
subscriptions.get(
  '/charges',
  ah(async (req, res) => {
    const rows = await query(`
      SELECT h.*, a.name AS account_name FROM (
        SELECT lt.ref_id AS sub_id, t.id, t.txn_date, t.posted_date, t.amount, t.merchant, t.description, t.account_id
        FROM line_tags lt
        JOIN transactions t ON t.id = lt.transaction_id
        WHERE lt.kind = 'subscription' AND lt.book_id = $1
        UNION ALL
        SELECT lt.ref_id AS sub_id, t.id, t.txn_date, t.posted_date, s.amount, t.merchant, t.description, t.account_id
        FROM line_tags lt
        JOIN transaction_splits s ON s.id = lt.split_id
        JOIN transactions t ON t.id = s.transaction_id
        WHERE lt.kind = 'subscription' AND lt.book_id = $1
      ) h
      LEFT JOIN accounts a ON a.id = h.account_id
      ORDER BY h.txn_date DESC NULLS LAST, h.id DESC
      LIMIT 2000
    `, [hh(req)]);
    res.json(rows);
  })
);

// One subscription's charges, with EXACT total + count computed in SQL. The book-wide
// /charges list above is capped, so a per-subscription total must never be derived by
// filtering+reducing it (that understates a long-running subscription once a book has
// many charges). The returned `charges` list is itself capped for display, but `total`
// and `count` cover every charge.
subscriptions.get(
  '/:id/charges',
  ah(async (req, res) => {
    const subId = await ownedSubscription(req);
    const bookId = hh(req);
    const CHARGES = `
      SELECT lt.ref_id AS sub_id, t.id, t.txn_date, t.posted_date, t.amount, t.merchant, t.description, t.account_id
        FROM line_tags lt JOIN transactions t ON t.id = lt.transaction_id
       WHERE lt.kind = 'subscription' AND lt.ref_id = $2 AND lt.book_id = $1
      UNION ALL
      SELECT lt.ref_id AS sub_id, t.id, t.txn_date, t.posted_date, s.amount, t.merchant, t.description, t.account_id
        FROM line_tags lt JOIN transaction_splits s ON s.id = lt.split_id
        JOIN transactions t ON t.id = s.transaction_id
       WHERE lt.kind = 'subscription' AND lt.ref_id = $2 AND lt.book_id = $1`;
    const agg = await one<{ total: number; count: number }>(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS total, COUNT(*)::int AS count FROM (${CHARGES}) h`,
      [bookId, subId]
    );
    const charges = await query(
      `SELECT h.*, a.name AS account_name FROM (${CHARGES}) h
         LEFT JOIN accounts a ON a.id = h.account_id
        ORDER BY h.txn_date DESC NULLS LAST, h.id DESC
        LIMIT 500`,
      [bookId, subId]
    );
    res.json({ charges, total: agg?.total ?? 0, count: agg?.count ?? 0 });
  })
);

// Likely-subscription candidates detected from recurring transactions.
subscriptions.get(
  '/suggestions',
  ah(async (req, res) => {
    res.json(await detectSuggestions(hh(req)));
  })
);

// Confirm a detected suggestion: create the subscription AND retro-link its
// existing charges to its managed category, so they show up immediately
// (instead of the user re-categorizing every past charge by hand). Charges are
// matched on the SAME normalized merchant key the suggestion was grouped on —
// not on amount — so subscriptions whose charges vary (proration, plan changes,
// usage-based billing) still pull in every charge.
subscriptions.post(
  '/suggestions/confirm',
  ah(async (req, res) => {
    require_(req.body, ['merchant']);
    const bookId = hh(req);
    const b = req.body;
    // This path used to bypass validateSubscription — apply the same value checks so a
    // suggested subscription can't be created with NaN/Infinity/negative money, a bogus
    // billing cycle, a bad date, or an unbounded name.
    const name = requiredString(b.merchant, 'merchant', { max: 200 });
    const amount = optionalMoney(b.amount, 'amount', { min: 0 }) ?? 0;
    const billingCycle = optionalEnumValue(b.billing_cycle, 'billing_cycle', SUBSCRIPTION_BILLING_CYCLES) ?? 'monthly';
    const nextDue = optionalDateOnly(b.next_due_date, 'next_due_date');
    const key = (b.key && String(b.key)) || recurringKey(name);
    // Optionally apply these charges to an EXISTING subscription instead of creating one.
    const targetId = b.subscription_id != null && b.subscription_id !== '' ? Number(b.subscription_id) : null;

    // Find this subscription's existing charges by normalized merchant key.
    const candidates = await query<{ id: number; merchant: string; account_id: number | null }>(
      `SELECT id, merchant, account_id FROM transactions
        WHERE book_id = $1 AND direction = 'expense'
          AND merchant IS NOT NULL AND btrim(merchant) <> ''`,
      [bookId]
    );
    const matchIds: number[] = [];
    const acctCounts = new Map<number, number>();
    for (const t of candidates) {
      if (recurringKey(t.merchant) !== key) continue;
      matchIds.push(t.id);
      if (t.account_id != null) acctCounts.set(t.account_id, (acctCounts.get(t.account_id) ?? 0) + 1);
    }
    // Auto-assign the account most of those charges came from.
    let accountId: number | null = null;
    let best = 0;
    for (const [aid, n] of acctCounts) if (n > best) { best = n; accountId = aid; }

    let row: any;
    if (targetId != null && Number.isInteger(targetId)) {
      // Apply to an existing subscription: adopt this merchant key so future charges
      // auto-link and the finder stops suggesting it. The subscription's own fields
      // (amount, cycle, account, etc.) are left exactly as the user set them up.
      row = await one(
        `UPDATE subscriptions SET merchant_key = $1 WHERE id = $2 AND book_id = $3 RETURNING *`,
        [key || null, targetId, bookId]
      );
      if (!row) throw new HttpError(404, 'Subscription not found in this book.');
    } else {
      row = await one(
        `INSERT INTO subscriptions
          (name, amount, billing_cycle, next_due_date, status, account_id, merchant_key, book_id)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7) RETURNING *`,
        [name, amount, billingCycle, nextDue, accountId, key || null, bookId]
      );
    }

    // Tag the matched charges with the new subscription (keeping their existing
    // categories). Best-effort: a link-up failure must not undo the subscription.
    let linked = 0;
    try {
      if (matchIds.length) {
        const updated = await query<{ transaction_id: number }>(
          `INSERT INTO line_tags (transaction_id, split_id, kind, ref_id, book_id)
           SELECT t.id, NULL, 'subscription', $1, $2
             FROM transactions t
            WHERE t.book_id = $2 AND t.id = ANY($3)
              AND NOT EXISTS (SELECT 1 FROM line_tags lt WHERE lt.transaction_id = t.id AND lt.kind = 'subscription' AND lt.ref_id = $1)
          ON CONFLICT DO NOTHING
          RETURNING transaction_id`,
          [row.id, bookId, matchIds]
        );
        linked = updated.length;
      }
    } catch (e) {
      console.error('subscription confirm link-up failed:', e);
    }

    res.status(201).json({ ...withDerived(row), linked });
  })
);

// Stop suggesting a merchant the user dismissed.
subscriptions.post(
  '/suggestions/ignore',
  ah(async (req, res) => {
    require_(req.body, ['merchant']);
    const merchant = String(req.body.merchant).trim();
    if (!merchant) throw new HttpError(400, 'merchant is required');
    await query(
      `INSERT INTO ignored_subscription_merchants (book_id, merchant)
       VALUES ($1, $2)
       ON CONFLICT (book_id, lower(merchant)) DO NOTHING`,
      [hh(req), merchant]
    );
    res.status(201).json({ ok: true });
  })
);

subscriptions.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name', 'amount']);
    const bookId = hh(req);
    const b = req.body;
    requiredString(b.name, 'name');
    await validateSubscription(b, bookId, true);
    const row = await one(
      `INSERT INTO subscriptions
        (name, amount, billing_cycle, next_due_date, category_id, account_id, status, start_date, notes, tier, service_type, login_url, login_id, website_url, phone, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        b.name, b.amount, b.billing_cycle ?? 'monthly', b.next_due_date ?? null,
        b.category_id ?? null, b.account_id ?? null, b.status ?? 'active',
        b.start_date ?? null, b.notes ?? null, b.tier ?? null, b.service_type ?? null,
        b.login_url ?? null, b.login_id ?? null, b.website_url ?? null, b.phone ?? null, bookId,
      ]
    );
    // Seed the price-history ledger with the starting price.
    await recordSubscriptionPrice(row, bookId, b.start_date);
    res.status(201).json(withDerived(row));
  })
);

// Edit the subscription's core fields. Status & end date are NOT touched here —
// they're owned by the dedicated /cancel, /pause and /reactivate actions (mirroring
// the vehicle/property dispose flow), so a details edit can't accidentally revert them.
subscriptions.put(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const b = req.body;
    await validateSubscription(b, bookId, false);
    const before = await one<{ amount: string; billing_cycle: string }>(
      `SELECT amount, billing_cycle FROM subscriptions WHERE id = $1 AND book_id = $2`,
      [req.params.id, bookId]
    );
    const row = await one(
      `UPDATE subscriptions SET
         name = COALESCE($2, name), amount = COALESCE($3, amount),
         billing_cycle = COALESCE($4, billing_cycle), next_due_date = $5,
         category_id = $6, account_id = $7,
         start_date = $8, notes = $9, tier = $10, service_type = $11,
         login_url = $12, login_id = $13, website_url = $14, phone = $15
       WHERE id = $1 AND book_id = $16 RETURNING *`,
      [
        req.params.id, b.name ?? null, b.amount ?? null, b.billing_cycle ?? null,
        b.next_due_date ?? null, b.category_id ?? null, b.account_id ?? null,
        b.start_date ?? null, b.notes ?? null, b.tier ?? null, b.service_type ?? null,
        b.login_url ?? null, b.login_id ?? null, b.website_url ?? null, b.phone ?? null, bookId,
      ]
    );
    if (!row) throw new HttpError(404, 'Subscription not found');
    // Capture a price-history entry whenever the price or billing cycle changes.
    if (before && (Math.abs(Number(before.amount) - Number(row.amount)) > 0.005 || before.billing_cycle !== row.billing_cycle)) {
      await recordSubscriptionPrice(row, bookId);
    }
    res.json(withDerived(row));
  })
);

subscriptions.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    await query(`DELETE FROM subscriptions WHERE id = $1 AND book_id = $2`, [req.params.id, bookId]);
    res.status(204).end();
  })
);

const todayISO = () => new Date().toISOString().slice(0, 10);

// Cancel effective `date` (defaults to today). A future date schedules the
// cancellation — the subscription stays active until then, when the sweep below
// flips it to canceled.
subscriptions.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const bookId = hh(req);
    const date = req.body?.date || todayISO();
    const immediate = date <= todayISO();
    const row = await one(
      immediate
        ? `UPDATE subscriptions SET status = 'canceled', end_date = $2 WHERE id = $1 AND book_id = $3 RETURNING *`
        : `UPDATE subscriptions SET end_date = $2 WHERE id = $1 AND book_id = $3 RETURNING *`,
      [req.params.id, date, bookId]
    );
    if (!row) throw new HttpError(404, 'Subscription not found');
    res.json(withDerived(row));
  })
);

// Pause a subscription: it stops counting toward monthly totals but keeps its
// history. Clears any scheduled cancellation. Resume via /reactivate.
subscriptions.post(
  '/:id/pause',
  ah(async (req, res) => {
    const bookId = hh(req);
    const row = await one(
      `UPDATE subscriptions SET status = 'paused', end_date = NULL WHERE id = $1 AND book_id = $2 RETURNING *`,
      [req.params.id, bookId]
    );
    if (!row) throw new HttpError(404, 'Subscription not found');
    res.json(withDerived(row));
  })
);

// Reactivate a canceled subscription (next charge = `date`), or clear a pending
// future cancellation on a still-active one (leaving its schedule untouched).
subscriptions.post(
  '/:id/reactivate',
  ah(async (req, res) => {
    const bookId = hh(req);
    const date = req.body?.date || todayISO();
    const row = await one(
      `UPDATE subscriptions
         SET status = 'active', end_date = NULL,
             next_due_date = CASE WHEN status = 'canceled' THEN $2::date ELSE next_due_date END
       WHERE id = $1 AND book_id = $3 RETURNING *`,
      [req.params.id, date, bookId]
    );
    if (!row) throw new HttpError(404, 'Subscription not found');
    res.json(withDerived(row));
  })
);

// Flip any subscriptions whose scheduled cancellation date has arrived. Runs
// lazily when subscriptions are listed (there's no scheduler). Book-scoped.
async function sweepDueCancellations(bookId: number) {
  const flipped = await query(
    `UPDATE subscriptions SET status = 'canceled'
     WHERE status <> 'canceled' AND end_date IS NOT NULL AND end_date <= CURRENT_DATE AND book_id = $1
     RETURNING id`,
    [bookId]
  );
}

// Log a payment: record an expense transaction against the linked category/account
// and roll the next renewal date forward by one billing cycle.
subscriptions.post(
  '/:id/pay',
  ah(async (req, res) => {
    const bookId = hh(req);
    optionalDateOnly(req.body?.txn_date, 'txn_date');
    const result = await withTransaction(async (client) => {
      // FOR UPDATE serializes concurrent "log a payment" requests on this subscription
      // so they can't race on the next_due_date advance below.
      const sub = (await client.query(`SELECT * FROM subscriptions WHERE id = $1 AND book_id = $2 FOR UPDATE`, [req.params.id, bookId])).rows[0];
      if (!sub) throw new HttpError(404, 'Subscription not found');

      // Idempotency: if this subscription already has a payment recorded for the same
      // date, return it instead of creating a duplicate — guards accidental double-clicks
      // and lost-response retries (the FOR UPDATE above serializes the concurrent case).
      const dup = (await client.query(
        `SELECT t.* FROM transactions t
           JOIN line_tags lt ON lt.transaction_id = t.id AND lt.book_id = $1
                            AND lt.kind = 'subscription' AND lt.ref_id = $2
          WHERE t.book_id = $1 AND t.txn_date = COALESCE($3::date, CURRENT_DATE)
          ORDER BY t.id LIMIT 1`,
        [bookId, sub.id, req.body?.txn_date ?? null]
      )).rows[0];
      if (dup) return { transaction: dup, subscription: withDerived(sub), duplicate: true };

      // Record the charge under the subscription's own category and tag it to the
      // subscription, so it counts in that category's budget AND in this sub's history.
      const txn = (await client.query(
        `INSERT INTO transactions
           (account_id, category_id, txn_date, posted_date, amount, direction, merchant, description, book_id)
         VALUES ($1,$2, COALESCE($3, CURRENT_DATE), COALESCE($3, CURRENT_DATE), $4, 'expense', $5, $6, $7) RETURNING *`,
        [sub.account_id, sub.category_id, req.body?.txn_date ?? null, sub.amount, sub.name, 'Subscription payment', bookId]
      )).rows[0];
      await client.query(
        `INSERT INTO line_tags (transaction_id, split_id, kind, ref_id, book_id) VALUES ($1, NULL, 'subscription', $2, $3) ON CONFLICT DO NOTHING`,
        [txn.id, sub.id, bookId]
      );

      const interval = CYCLE_INTERVAL[sub.billing_cycle] ?? '1 month';
      const updated = (await client.query(
        `UPDATE subscriptions
           SET next_due_date = COALESCE(next_due_date, CURRENT_DATE) + INTERVAL '${interval}'
         WHERE id = $1 AND book_id = $2 RETURNING *`,
        [req.params.id, bookId]
      )).rows[0];

      return { transaction: txn, subscription: withDerived(updated) };
    });
    res.status(201).json(result);
  })
);

// Price-history ledger for a subscription (newest first).
subscriptions.get(
  '/:id/price-history',
  ah(async (req, res) => {
    await ownedSubscription(req);
    res.json(await query(
      `SELECT id, amount, billing_cycle, to_char(effective_date,'YYYY-MM-DD') AS effective_date
       FROM subscription_price_history WHERE subscription_id = $1 AND book_id = $2
       ORDER BY effective_date DESC, id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

// --- Documents attached to a subscription (invoices, receipts, contracts, …) ---
subscriptions.get(
  '/:id/documents',
  ah(async (req, res) => {
    await ownedSubscription(req);
    res.json(await query(
      `SELECT id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM subscription_documents WHERE subscription_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

subscriptions.post(
  '/:id/documents',
  ah(async (req, res) => {
    require_(req.body, ['file']);
    const bookId = hh(req);
    await ownedSubscription(req);
    const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
    if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
    const safeMime = assertUploadMime(file_mime);
    assertUploadSize(file);
    const buf = Buffer.from(file, 'base64');
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const row = await one(
      `INSERT INTO subscription_documents (subscription_id, book_id, doc_type, name, file, file_mime, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
      [req.params.id, bookId, docType, name || file_name, buf, safeMime, file_name]
    );
    res.status(201).json(row);
  })
);

// Update a document's metadata (name + type), optionally replacing the stored file.
subscriptions.put(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await ownedSubscription(req);
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
        `UPDATE subscription_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
         WHERE id = $6 AND subscription_id = $7 AND book_id = $8 ${returning}`,
        [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
      );
    } else {
      row = await one(
        `UPDATE subscription_documents SET name = $1, doc_type = $2
         WHERE id = $3 AND subscription_id = $4 AND book_id = $5 ${returning}`,
        [name, docType, req.params.docId, req.params.id, hh(req)]
      );
    }
    if (!row) throw new HttpError(404, 'Document not found.');
    res.json(row);
  })
);

subscriptions.get(
  '/:id/documents/:docId/file',
  ah(async (req, res) => {
    await ownedSubscription(req);
    const r = await one<any>(
      `SELECT file, file_mime, file_name FROM subscription_documents WHERE id = $1 AND subscription_id = $2 AND book_id = $3`,
      [req.params.docId, req.params.id, hh(req)]
    );
    if (!r || !r.file) throw new HttpError(404, 'Document not found.');
    sendStoredFile(res, r.file, r.file_mime, r.file_name);
  })
);

subscriptions.delete(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await query(`DELETE FROM subscription_documents WHERE id = $1 AND subscription_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
    res.status(204).end();
  })
);
