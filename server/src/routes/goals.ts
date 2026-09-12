import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { periodWindow } from './budgets.js';
import { ACCOUNT_BALANCES, EFFECTIVE_LINES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { todayInTz } from '../dates.js';
import {
  requiredString, enumValue, optionalEnumValue, optionalMoney, optionalDateOnly, ownedRef, round2,
  GOAL_TYPES, GOAL_STATUSES, GOAL_PERIODS,
} from '../validation.js';

// Validate a goal body's value fields + cross-book references (throws 400/404).
async function validateGoal(b: any, bookId: number, goalTypeRequired: boolean): Promise<void> {
  if (goalTypeRequired) enumValue(b.goal_type, 'goal_type', GOAL_TYPES);
  else optionalEnumValue(b.goal_type, 'goal_type', GOAL_TYPES);
  optionalEnumValue(b.status, 'status', GOAL_STATUSES);
  optionalEnumValue(b.period, 'period', GOAL_PERIODS);
  optionalMoney(b.target_amount, 'target_amount');
  optionalMoney(b.current_amount, 'current_amount');
  optionalMoney(b.baseline_amount, 'baseline_amount');
  optionalDateOnly(b.target_date, 'target_date');
  await ownedRef('account', b.account_id, bookId, 'account_id');
  await ownedRef('category', b.category_id, bookId, 'category_id');
  await ownedRef('liability', b.liability_id, bookId, 'liability_id');
  await ownedRef('asset', b.asset_id, bookId, 'asset_id');
}

export const goals = Router();

const num = (x: any): number | null => (x == null || x === '' ? null : Number(x));

// Resolve the "current value" used to measure a savings or debt goal: prefer a
// linked live source (account balance, asset value, liability balance), else the
// manually entered amount. All linked-source lookups are book-scoped.
async function accountBalance(accountId: number, bookId: number): Promise<number> {
  const r = await one<{ posted_balance: string }>(
    `WITH ${ACCOUNT_BALANCES} SELECT posted_balance FROM acct_bal WHERE id = $1 AND book_id = $2`,
    [accountId, bookId]
  );
  return r ? Number(r.posted_balance) : 0;
}

// `today` lets the caller pass the user's LOCAL date (so reduce-spending goals use the
// right current period for users west of UTC); defaults to the server's UTC date.
async function resolveProgress(g: any, bookId: number, today = new Date().toISOString().slice(0, 10)) {
  const target = num(g.target_amount) ?? 0;

  if (g.goal_type === 'savings') {
    let current = 0;
    if (g.account_id) current = await accountBalance(g.account_id, bookId);
    else if (g.asset_id) {
      const r = await one<{ value: string }>(`SELECT value FROM assets WHERE id = $1 AND book_id = $2`, [g.asset_id, bookId]);
      current = r ? Number(r.value ?? 0) : 0;
    } else current = num(g.current_amount) ?? 0;

    const pct = target > 0 ? (current / target) * 100 : 0;
    return {
      current: round2(current), target, pct,
      remaining: round2(Math.max(0, target - current)),
      state: target > 0 && current >= target ? 'achieved' : 'on_track',
    };
  }

  if (g.goal_type === 'debt_payoff') {
    let current = 0;
    if (g.liability_id) {
      const r = await one<{ balance: string }>(`SELECT balance FROM liabilities WHERE id = $1 AND book_id = $2`, [g.liability_id, bookId]);
      current = r ? Number(r.balance ?? 0) : 0;
    } else if (g.account_id) current = await accountBalance(g.account_id, bookId);
    else current = num(g.current_amount) ?? 0;

    const baseline = num(g.baseline_amount) ?? current;
    const span = baseline - target;
    const paid = Math.max(0, baseline - current);
    const pct = span > 0 ? (paid / span) * 100 : current <= target ? 100 : 0;
    return {
      current: round2(current), target, baseline: round2(baseline), paid: round2(paid), pct,
      remaining: round2(Math.max(0, current - target)),
      state: current <= target ? 'achieved' : 'on_track',
    };
  }

  // reduce_spending: actual spend in the current period vs the cap.
  const period = g.period || 'monthly';
  const win = periodWindow(period, today);
  // Use effective lines so split transactions are attributed to their parts.
  const spentRow = await one<{ spent: string }>(
    `WITH ${EFFECTIVE_LINES}
     SELECT COALESCE(SUM(amount),0) AS spent FROM eff
     WHERE direction = 'expense' AND txn_date BETWEEN $1 AND $2 AND book_id = $4
       AND (category_id = $3 OR category_id IN (SELECT id FROM categories WHERE parent_id = $3))`,
    [win.start, win.end, g.category_id, bookId]
  );
  const current = round2(Number(spentRow?.spent ?? 0));
  const pct = target > 0 ? (current / target) * 100 : 0;
  return {
    current, target, pct,
    remaining: round2(target - current), // negative => over the cap
    period,
    windowLabel: win.label,
    state: target > 0 && current > target ? 'over' : 'on_track',
  };
}

goals.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const rows = await query(`
      SELECT g.*,
             a.name AS account_name, c.name AS category_name,
             l.name AS liability_name, ast.name AS asset_name
      FROM goals g
      LEFT JOIN accounts a    ON a.id = g.account_id
      LEFT JOIN categories c  ON c.id = g.category_id
      LEFT JOIN liabilities l ON l.id = g.liability_id
      LEFT JOIN assets ast    ON ast.id = g.asset_id
      WHERE g.book_id = $1
      ORDER BY g.status, g.created_at DESC
    `, [bookId]);
    // The client passes its local date as ref so "current period" is resolved in the
    // user's timezone, not the server's UTC day.
    const ref = optionalDateOnly(req.query.ref, 'ref') ?? todayInTz(req.user?.timezone);
    const out = [];
    for (const g of rows) out.push({ ...g, progress: await resolveProgress(g, bookId, ref) });
    res.json(out);
  })
);

goals.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name', 'goal_type']);
    const b = req.body;
    requiredString(b.name, 'name');
    await validateGoal(b, hh(req), true);
    const row = await one(
      `INSERT INTO goals
        (name, goal_type, target_amount, current_amount, baseline_amount, period,
         account_id, category_id, liability_id, asset_id, target_date, status, notes, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        b.name, b.goal_type, num(b.target_amount), num(b.current_amount), num(b.baseline_amount),
        b.period ?? null, b.account_id ?? null, b.category_id ?? null, b.liability_id ?? null,
        b.asset_id ?? null, b.target_date ?? null, b.status ?? 'active', b.notes ?? null, hh(req),
      ]
    );
    res.status(201).json({ ...row, progress: await resolveProgress(row, hh(req), todayInTz(req.user?.timezone)) });
  })
);

goals.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body;
    await validateGoal(b, hh(req), false);
    const row = await one(
      `UPDATE goals SET
         name = COALESCE($2, name),
         goal_type = COALESCE($3, goal_type),
         target_amount = $4, current_amount = $5, baseline_amount = $6, period = $7,
         account_id = $8, category_id = $9, liability_id = $10, asset_id = $11,
         target_date = $12, status = COALESCE($13, status), notes = $14
       WHERE id = $1 AND book_id = $15 RETURNING *`,
      [
        req.params.id, b.name ?? null, b.goal_type ?? null, num(b.target_amount), num(b.current_amount),
        num(b.baseline_amount), b.period ?? null, b.account_id ?? null, b.category_id ?? null,
        b.liability_id ?? null, b.asset_id ?? null, b.target_date ?? null, b.status ?? null, b.notes ?? null, hh(req),
      ]
    );
    if (!row) throw new HttpError(404, 'Goal not found');
    res.json({ ...row, progress: await resolveProgress(row, hh(req), todayInTz(req.user?.timezone)) });
  })
);

goals.delete(
  '/:id',
  ah(async (req, res) => {
    await query(`DELETE FROM goals WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);
