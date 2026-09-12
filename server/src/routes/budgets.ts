import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, HttpError } from '../http.js';
import { EFFECTIVE_LINES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { todayInTz } from '../dates.js';
import {
  requiredString, dateOnly, optionalDateOnly, optionalEnumValue, integerId, money, optionalMoney,
  assertOwned, BUDGET_PERIODS, ROLLOVER_MODES,
} from '../validation.js';

export const budgets = Router();

// Confirm a budget belongs to the active book, or 404.
async function ownedBudget(req: any): Promise<number> {
  const b = await one<{ id: number }>(`SELECT id FROM budgets WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!b) throw new HttpError(404, 'Budget not found');
  return b.id;
}

budgets.get(
  '/',
  ah(async (req, res) => {
    res.json(await query(`SELECT * FROM budgets WHERE book_id = $1 ORDER BY created_at DESC`, [hh(req)]));
  })
);

budgets.post(
  '/',
  ah(async (req, res) => {
    const name = requiredString(req.body?.name, 'name');
    const period = optionalEnumValue(req.body?.period, 'period', BUDGET_PERIODS) ?? 'monthly';
    const start_date = optionalDateOnly(req.body?.start_date, 'start_date');
    const end_date = optionalDateOnly(req.body?.end_date, 'end_date');
    if (period === 'custom') {
      if (!start_date || !end_date) throw new HttpError(400, 'A custom budget needs a start and end date.');
      if (end_date < start_date) throw new HttpError(400, 'End date must be on or after the start date.');
    }
    const row = await one(
      `INSERT INTO budgets (name, period, start_date, end_date, book_id)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5) RETURNING *`,
      [name, period, start_date, period === 'custom' ? end_date : null, hh(req)]
    );
    res.status(201).json(row);
  })
);

budgets.delete(
  '/:id',
  ah(async (req, res) => {
    await query(`DELETE FROM budgets WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// --- Budget lines (per-item allocations) ---
budgets.get(
  '/:id/lines',
  ah(async (req, res) => {
    await ownedBudget(req);
    const rows = await query(
      `SELECT bl.*, c.name AS category_name, c.kind AS category_kind,
              COALESCE(p.name, '') AS group_name
       FROM budget_lines bl
       JOIN categories c ON c.id = bl.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE bl.budget_id = $1
       ORDER BY c.kind, lower(COALESCE(p.name, c.name)), lower(c.name)`,
      [req.params.id]
    );
    res.json(rows);
  })
);

budgets.post(
  '/:id/lines',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedBudget(req);
    const category_id = integerId(req.body?.category_id, 'category_id');
    const amount = money(req.body?.amount, 'amount');
    // The category must belong to this book.
    await assertOwned('category', category_id, bookId);
    const mode = optionalEnumValue(req.body?.rollover_mode, 'rollover_mode', ROLLOVER_MODES) ?? 'reset';
    // opening_balance is preserved when omitted (inline amount edits don't send it).
    const opening = optionalMoney(req.body?.opening_balance, 'opening_balance');
    const row = await one(
      `INSERT INTO budget_lines (budget_id, category_id, amount, rollover_mode, opening_balance, book_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6)
       ON CONFLICT (budget_id, category_id) DO UPDATE SET
         amount = EXCLUDED.amount, rollover_mode = EXCLUDED.rollover_mode,
         opening_balance = COALESCE($5, budget_lines.opening_balance)
       RETURNING *`,
      [req.params.id, category_id, amount, mode, opening, bookId]
    );
    res.status(201).json(row);
  })
);

budgets.delete(
  '/:id/lines/:lineId',
  ah(async (req, res) => {
    await ownedBudget(req);
    await query(`DELETE FROM budget_lines WHERE id = $1 AND budget_id = $2`, [
      req.params.lineId,
      req.params.id,
    ]);
    res.status(204).end();
  })
);

// --- Budget period snapshots -------------------------------------------------
// Freeze the budget's current planned lines for a date window, so historical
// plan-vs-actual no longer changes when a line is edited for a future period.
budgets.post(
  '/:id/periods',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedBudget(req);
    const budgetId = Number(req.params.id);
    const period_start = dateOnly(req.body?.period_start, 'period_start');
    const period_end = dateOnly(req.body?.period_end, 'period_end');
    if (period_end < period_start) throw new HttpError(400, 'period_end must be on or after period_start.');
    const period = await withTransaction(async (client) => {
      const p = (await client.query(
        `INSERT INTO budget_periods (book_id, budget_id, period_start, period_end, status)
         VALUES ($1,$2,$3,$4,'closed')
         ON CONFLICT (budget_id, period_start, period_end) DO UPDATE SET status = 'closed'
         RETURNING *`,
        [bookId, budgetId, period_start, period_end]
      )).rows[0];
      // Re-snapshot: replace any prior frozen lines with the current planned lines,
      // capturing the category name + kind so the report survives later edits.
      await client.query(`DELETE FROM budget_period_lines WHERE period_id = $1`, [p.id]);
      // Freeze the item label/kind AND the group (parent) label/sort, so a later
      // rename of either the category or its parent can't rewrite this report.
      await client.query(
        `INSERT INTO budget_period_lines
           (book_id, period_id, category_id, category_name, category_kind, planned_amount, rollover_mode, opening_balance,
            group_id, group_name, group_sort)
         SELECT $1, $2, bl.category_id, c.name, c.kind, bl.amount, bl.rollover_mode, bl.opening_balance,
                COALESCE(p.id, c.id), COALESCE(p.name, c.name), COALESCE(p.sort_order, c.sort_order)
         FROM budget_lines bl
         JOIN categories c ON c.id = bl.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         WHERE bl.budget_id = $3 AND bl.book_id = $1`,
        [bookId, p.id, budgetId]
      );
      return p;
    });
    res.status(201).json(period);
  })
);

budgets.get(
  '/:id/periods',
  ah(async (req, res) => {
    await ownedBudget(req);
    res.json(await query(
      `SELECT * FROM budget_periods WHERE budget_id = $1 AND book_id = $2 ORDER BY period_start DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

// --- Account scoping: which accounts' transactions count (empty = all) ---
budgets.put(
  '/:id/accounts',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedBudget(req);
    const raw = req.body?.account_ids;
    if (raw != null && !Array.isArray(raw)) throw new HttpError(400, 'account_ids must be an array.');
    // Validate EVERY provided id BEFORE touching the table: malformed → 400,
    // cross-book / missing → 404. A single bad id rejects the whole request
    // so the scope is never partially rewritten.
    const validated: number[] = [];
    for (const a of Array.isArray(raw) ? raw : []) {
      const id = integerId(a, 'account_id');
      await assertOwned('account', id, bookId);
      validated.push(id);
    }
    const ids = [...new Set(validated)];
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM budget_accounts WHERE budget_id = $1`, [req.params.id]);
      for (const aid of ids) {
        await client.query(
          `INSERT INTO budget_accounts (budget_id, account_id, book_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [req.params.id, aid, bookId]
        );
      }
    });
    // Echo back what is actually persisted, not the raw request.
    const persisted = await query(`SELECT account_id FROM budget_accounts WHERE budget_id = $1 ORDER BY account_id`, [req.params.id]);
    res.json({ account_ids: (persisted as any[]).map((r) => Number(r.account_id)) });
  })
);

/**
 * Budget vs actual for the period containing `ref` (default: today).
 * Splits into an Income section and an Expense section. Within each, allocated
 * items are grouped under their high-level category, and any actual activity in
 * the window that isn't covered by an allocation rolls into an "Uncategorized"
 * bucket so the budget reflects every transaction.
 */
budgets.get(
  '/:id/progress',
  ah(async (req, res) => {
    const bookId = hh(req);
    const budget = await one<{ id: number; period: string; start_str: string | null; end_str: string | null }>(
      `SELECT id, period,
              to_char(start_date, 'YYYY-MM-DD') AS start_str,
              to_char(end_date, 'YYYY-MM-DD')   AS end_str
       FROM budgets WHERE id = $1 AND book_id = $2`,
      [req.params.id, bookId]
    );
    if (!budget) throw new HttpError(404, 'Budget not found');

    const ref = (req.query.ref as string) || todayInTz(req.user?.timezone);
    // A custom budget has a fixed window; recurring budgets derive it from `ref`.
    const { start, end, label } = budget.period === 'custom'
      ? {
          start: budget.start_str ?? ref,
          end: budget.end_str ?? budget.start_str ?? ref,
          label: customLabel(budget.start_str, budget.end_str),
        }
      : periodWindow(budget.period, ref);

    // If this window was frozen as a budget period, read the FROZEN planned lines
    // (so a later edit to a line can't change this historical report); otherwise
    // read the live budget_lines. Actuals are always derived live from transactions.
    const snapPeriod = await one<{ id: number }>(
      `SELECT id FROM budget_periods WHERE budget_id = $1 AND period_start = $2 AND period_end = $3 AND book_id = $4 AND status = 'closed'`,
      [req.params.id, start, end, bookId]
    );
    const lineRows = snapPeriod
      ? await query(
          // Closed period: labels (name/kind) and planned figures come from the
          // FROZEN snapshot so a later category rename/edit can't rewrite history.
          // Live category data is used ONLY for layout (parent grouping + sort),
          // never for the displayed labels.
          `SELECT bpl.id AS line_id, bpl.category_id, bpl.planned_amount AS allocated, bpl.rollover_mode, bpl.opening_balance,
                  COALESCE(bpl.category_name, c.name) AS category_name,
                  COALESCE(bpl.category_kind, c.kind) AS kind,
                  COALESCE(bpl.group_id, p.id, c.id, bpl.category_id, bpl.id) AS group_id,
                  COALESCE(bpl.group_name, p.name, bpl.category_name, c.name) AS group_name,
                  COALESCE(bpl.group_sort, p.sort_order, c.sort_order, 0) AS group_sort,
                  COALESCE(c.sort_order, 0) AS item_sort
           FROM budget_period_lines bpl
           LEFT JOIN categories c ON c.id = bpl.category_id
           LEFT JOIN categories p ON p.id = c.parent_id
           WHERE bpl.period_id = $1`,
          [snapPeriod.id]
        )
      : await query(
          `SELECT bl.id AS line_id, bl.category_id, bl.amount AS allocated, bl.rollover_mode, bl.opening_balance,
                  c.name AS category_name, c.kind AS kind,
                  COALESCE(p.id, c.id) AS group_id,
                  COALESCE(p.name, c.name) AS group_name,
                  COALESCE(p.sort_order, c.sort_order) AS group_sort,
                  c.sort_order AS item_sort
           FROM budget_lines bl
           JOIN categories c ON c.id = bl.category_id
           LEFT JOIN categories p ON p.id = c.parent_id
           WHERE bl.budget_id = $1`,
          [req.params.id]
        );

    // Optional account scoping: when the budget lists accounts, only those count.
    const acctRows = await query(`SELECT account_id FROM budget_accounts WHERE budget_id = $1`, [req.params.id]);
    const acctIds: number[] | null = acctRows.length ? (acctRows as any[]).map((r) => Number(r.account_id)) : null;
    const acctClause = `AND ($3::int[] IS NULL OR account_id = ANY($3)) AND book_id = $4`;

    // Actuals in the window, per category and direction, plus per-direction totals.
    const actualRows = await query(
      `WITH ${EFFECTIVE_LINES}
       SELECT category_id, direction, SUM(amount)::float8 AS total
       FROM eff
       WHERE txn_date BETWEEN $1 AND $2 AND category_id IS NOT NULL ${acctClause}
       GROUP BY category_id, direction`,
      [start, end, acctIds, bookId]
    );
    const totalRows = await query(
      `WITH ${EFFECTIVE_LINES}
       SELECT direction, SUM(amount)::float8 AS total
       FROM eff WHERE txn_date BETWEEN $1 AND $2 ${acctClause}
       GROUP BY direction`,
      [start, end, acctIds, bookId]
    );

    // Daily activity across the window (filled below), for the cash-flow tracker.
    const dailyRows = await query(
      `WITH ${EFFECTIVE_LINES}
       SELECT to_char(txn_date, 'YYYY-MM-DD') AS date,
              SUM(amount) FILTER (WHERE direction = 'income')::float8  AS income,
              SUM(amount) FILTER (WHERE direction = 'expense')::float8 AS expense
       FROM eff WHERE txn_date BETWEEN $1 AND $2 ${acctClause}
       GROUP BY 1`,
      [start, end, acctIds, bookId]
    );
    const dailyMap = new Map<string, { income: number; expense: number }>();
    for (const r of dailyRows as any[]) dailyMap.set(r.date, { income: Number(r.income) || 0, expense: Number(r.expense) || 0 });
    // Yearly budgets bucket by week (Monday-start) to keep the chart readable;
    // everything shorter is per-day.
    const bucket: 'day' | 'week' = budget.period === 'yearly' ? 'week' : 'day';
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const agg = new Map<string, { income: number; expense: number }>();
    let guard = 0;
    for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end && guard++ < 600; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      const v = dailyMap.get(day) ?? { income: 0, expense: 0 };
      const key = bucket === 'week' ? mondayUTCStr(d) : day;
      const cur = agg.get(key) ?? { income: 0, expense: 0 };
      cur.income += v.income; cur.expense += v.expense;
      agg.set(key, cur);
    }
    const daily = [...agg.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, income: r2(v.income), expense: r2(v.expense), net: r2(v.income - v.expense) }));

    const actualMap = new Map<string, number>();
    for (const r of actualRows as any[]) actualMap.set(`${r.category_id}:${r.direction}`, Number(r.total));
    const totalByDir: Record<string, number> = { expense: 0, income: 0 };
    for (const r of totalRows as any[]) totalByDir[r.direction] = Number(r.total);

    // Rollover: for carryover/accrue lines, fold prior periods' net leftover into
    // this period's available amount. Doesn't apply to custom (single-window) budgets.
    const rolloverActive = budget.period !== 'custom' && budget.start_str
      && (lineRows as any[]).some((l) => l.rollover_mode && l.rollover_mode !== 'reset');
    const priorMap = new Map<string, number>();
    let periodsN = 1;
    if (rolloverActive) {
      periodsN = periodsElapsed(budget.period, budget.start_str!, ref);
      const pe = new Date(start + 'T00:00:00'); pe.setDate(pe.getDate() - 1);
      const priorEnd = pe.toISOString().slice(0, 10);
      if (budget.start_str! <= priorEnd) {
        const priorRows = await query(
          `WITH ${EFFECTIVE_LINES}
           SELECT category_id, direction, SUM(amount)::float8 AS total
           FROM eff WHERE txn_date BETWEEN $1 AND $2 AND category_id IS NOT NULL
             AND ($3::int[] IS NULL OR account_id = ANY($3)) AND book_id = $4
           GROUP BY category_id, direction`,
          [budget.start_str, priorEnd, acctIds, bookId]
        );
        for (const r of priorRows as any[]) priorMap.set(`${r.category_id}:${r.direction}`, Number(r.total));
      }
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const buildSection = (kind: 'expense' | 'income') => {
      const kindLines = (lineRows as any[]).filter((l) => l.kind === kind);
      const groups = new Map<number, any>();
      for (const l of kindLines) {
        const actual = actualMap.get(`${l.category_id}:${kind}`) ?? 0;
        const base = Number(l.allocated);
        const mode = l.rollover_mode ?? 'reset';
        const opening = Number(l.opening_balance) || 0;
        let available = base, carryIn = 0;
        if (rolloverActive && mode !== 'reset') {
          const priorSpent = priorMap.get(`${l.category_id}:${kind}`) ?? 0;
          const raw = round2(opening + (periodsN - 1) * base - priorSpent);
          carryIn = mode === 'carryover' ? Math.max(0, raw) : raw;
          available = round2(base + carryIn);
        }
        if (!groups.has(l.group_id)) {
          groups.set(l.group_id, { group_id: l.group_id, group_name: l.group_name, group_sort: Number(l.group_sort), allocated: 0, actual: 0, lines: [] });
        }
        const g = groups.get(l.group_id);
        g.allocated += available;
        g.actual += actual;
        g.lines.push({
          line_id: l.line_id,
          category_id: l.category_id,
          category_name: l.category_name,
          allocated: available,
          base_amount: base,
          rollover_mode: mode,
          opening_balance: opening,
          carry_in: carryIn,
          actual,
          item_sort: Number(l.item_sort),
        });
      }
      const groupList = [...groups.values()].sort((a, b) => a.group_sort - b.group_sort || a.group_name.localeCompare(b.group_name));
      for (const g of groupList) {
        g.lines.sort((a: any, b: any) => a.item_sort - b.item_sort);
        // Round the per-group rollups so accumulated float noise never reaches the UI.
        g.allocated = round2(g.allocated);
        g.actual = round2(g.actual);
      }
      const allocated = round2(groupList.reduce((s, g) => s + g.allocated, 0));
      const budgetedActual = round2(groupList.reduce((s, g) => s + g.actual, 0));
      const uncategorized = round2(Math.max(0, (totalByDir[kind] ?? 0) - budgetedActual));
      return {
        kind,
        groups: groupList,
        uncategorized,
        allocated,
        actual: budgetedActual,
        total_actual: round2(budgetedActual + uncategorized),
      };
    };

    res.json({
      period: budget.period,
      window: { start, end, label },
      account_ids: acctIds ?? [],
      bucket,
      daily,
      sections: [buildSection('expense'), buildSection('income')],
    });
  })
);

// Transactions behind a section's actual (scope=section) or its uncategorized
// bucket (scope=uncategorized), within the period window and account scope.
budgets.get(
  '/:id/transactions',
  ah(async (req, res) => {
    const bookId = hh(req);
    const budget = await one<{ period: string; start_str: string | null; end_str: string | null }>(
      `SELECT period, to_char(start_date,'YYYY-MM-DD') AS start_str, to_char(end_date,'YYYY-MM-DD') AS end_str FROM budgets WHERE id = $1 AND book_id = $2`,
      [req.params.id, bookId]
    );
    if (!budget) throw new HttpError(404, 'Budget not found');
    const ref = (req.query.ref as string) || todayInTz(req.user?.timezone);
    const { start, end } = budget.period === 'custom'
      ? { start: budget.start_str ?? ref, end: budget.end_str ?? budget.start_str ?? ref }
      : periodWindow(budget.period, ref);
    const kind = req.query.kind === 'income' ? 'income' : 'expense';
    const scope = req.query.scope === 'section' ? 'section' : 'uncategorized';
    // Explicit category filter (clicking a group/line's spent figure).
    const catsParam = (req.query.cats as string) || '';
    const cats = catsParam ? catsParam.split(',').map(Number).filter((n) => Number.isFinite(n)) : null;

    const acctRows = await query(`SELECT account_id FROM budget_accounts WHERE budget_id = $1`, [req.params.id]);
    const acctIds: number[] | null = acctRows.length ? (acctRows as any[]).map((r) => Number(r.account_id)) : null;
    const catRows = await query(
      `SELECT bl.category_id FROM budget_lines bl JOIN categories c ON c.id = bl.category_id WHERE bl.budget_id = $1 AND c.kind = $2`,
      [req.params.id, kind]
    );
    const budgetCatIds = (catRows as any[]).map((r) => Number(r.category_id));
    const filterCats = cats ?? budgetCatIds;
    const useAny = cats != null || scope === 'section';
    const scopeClause = useAny
      ? `AND eff.category_id = ANY($4::int[])`
      : `AND (eff.category_id IS NULL OR NOT (eff.category_id = ANY($4::int[])))`;

    // The transaction LIST is paginated; the summary total below counts the full set.
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const transactions = await query(
      `WITH ${EFFECTIVE_LINES}
       SELECT eff.id AS txn_id, eff.split_id, to_char(eff.txn_date,'YYYY-MM-DD') AS txn_date,
              eff.amount::float8 AS amount, eff.category_id, c.name AS category_name,
              a.name AS account_name, t.merchant, t.description
       FROM eff
       JOIN transactions t ON t.id = eff.id
       LEFT JOIN categories c ON c.id = eff.category_id
       LEFT JOIN accounts a ON a.id = eff.account_id
       WHERE eff.txn_date BETWEEN $1 AND $2 AND eff.direction = $3
         AND ($5::int[] IS NULL OR eff.account_id = ANY($5::int[]))
         AND eff.book_id = $6
         ${scopeClause}
       ORDER BY eff.txn_date DESC, eff.id DESC
       LIMIT $7 OFFSET $8`,
      [start, end, kind, filterCats, acctIds, bookId, limit, offset]
    );
    const cnt = await one<{ n: number }>(
      `WITH ${EFFECTIVE_LINES}
       SELECT COUNT(*)::int AS n
       FROM eff
       WHERE eff.txn_date BETWEEN $1 AND $2 AND eff.direction = $3
         AND ($5::int[] IS NULL OR eff.account_id = ANY($5::int[]))
         AND eff.book_id = $6
         ${scopeClause}`,
      [start, end, kind, filterCats, acctIds, bookId]
    );
    const total = Number(cnt?.n ?? 0);
    res.json({ transactions, total });
  })
);

function customLabel(start: string | null, end: string | null) {
  if (!start) return 'Custom range';
  const fmt = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return end && end !== start ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
}

// The Monday (UTC) of the week containing `d`, as YYYY-MM-DD.
function mondayUTCStr(d: Date): string {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

// How many periods have elapsed from the budget's start through the period
// containing `ref` (inclusive). 1 = we're in the first period.
function periodsElapsed(period: string, startStr: string, ref: string): number {
  const cur = periodWindow(period, ref).start;
  let w = periodWindow(period, startStr);
  let n = 1;
  let guard = 0;
  while (w.start < cur && guard++ < 2000) {
    const next = new Date(w.end + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    w = periodWindow(period, next.toISOString().slice(0, 10));
    n++;
  }
  return n;
}

export function periodWindow(period: string, refStr: string) {
  const ref = new Date(refStr + 'T00:00:00');
  const y = ref.getFullYear();
  const m = ref.getMonth();

  if (period === 'yearly') {
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  }
  if (period === 'weekly') {
    const day = ref.getDay(); // 0 = Sun
    const diffToMon = (day + 6) % 7;
    const mon = new Date(ref);
    mon.setDate(ref.getDate() - diffToMon);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return { start: fmt(mon), end: fmt(sun), label: `Week of ${fmt(mon)}` };
  }
  // monthly (default)
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 0);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { start: fmt(start), end: fmt(end), label };
}
