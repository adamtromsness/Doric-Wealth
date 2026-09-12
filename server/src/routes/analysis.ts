import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { ask, resolveAiCreds, AiNotConfiguredError } from '../ai/claude.js';
import { vehicleSummary } from './vehicles.js';
import { propertySummary } from './properties.js';
import { config } from '../config.js';
import { EFFECTIVE_LINES, EFFECTIVE_LINE_TAGS, ACCOUNT_BALANCES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { requiredString, round2 } from '../validation.js';

export const analysis = Router();

const money = (n: number | null | undefined) =>
  n == null ? 'n/a' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

analysis.get('/status', ah(async (_req, res) => {
  const { apiKey, model } = await resolveAiCreds();
  res.json({ configured: Boolean(apiKey), model });
}));

// List previously saved analyses
analysis.get(
  '/',
  ah(async (req, res) => {
    const params: any[] = [hh(req)];
    let where = 'WHERE book_id = $1';
    if (req.query.kind) {
      params.push(req.query.kind);
      where += ' AND kind = $2';
    }
    res.json(await query(`SELECT * FROM ai_analyses ${where} ORDER BY created_at DESC LIMIT 100`, params));
  })
);

async function save(kind: string, subjectId: number | null, title: string, result: string, bookId: number) {
  return one(
    `INSERT INTO ai_analyses (kind, subject_id, title, result, model, book_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [kind, subjectId, title, result, config.anthropicModel, bookId]
  );
}

// --- Vehicle cost of ownership ---
analysis.post(
  '/vehicle/:id/cost-of-ownership',
  ah(async (req, res) => {
    const bookId = hh(req);
    const s = await vehicleSummary(Number(req.params.id), bookId);
    const v: any = s.vehicle;

    const recent = await query(
      `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
       SELECT eff_tag.txn_date, eff_tag.amount, t.merchant, t.description, c.name AS category
       FROM eff_tag
       JOIN transactions t ON t.id = eff_tag.id
       LEFT JOIN categories c ON c.id = eff_tag.category_id
       WHERE eff_tag.kind = 'vehicle' AND eff_tag.ref_id = $1 AND eff_tag.direction = 'expense'
         AND eff_tag.book_id = $2
       ORDER BY eff_tag.txn_date DESC LIMIT 60`,
      [req.params.id, bookId]
    );

    const prompt = `Analyze the total cost of ownership for this vehicle and give practical insights.

VEHICLE
- ${v.year ?? ''} ${v.make ?? ''} ${v.model ?? ''} (${v.name})
- Purchase price: ${money(v.purchase_price)}
- Current value: ${money(v.current_value)}
- Depreciation so far: ${money(s.depreciation)}
- Months owned: ${s.monthsOwned ?? 'n/a'}
- Miles driven: ${s.milesDriven ?? 'n/a'}

SPENDING BY CATEGORY
${s.byCategory.map((c: any) => `- ${c.category_name ?? 'Uncategorized'}: ${money(c.total)} (${c.count} txns)`).join('\n') || '- (none recorded)'}

COMPUTED
- Total spent on the vehicle (excl. depreciation): ${money(s.totalSpent)}
- Total cost of ownership (incl. depreciation): ${money(s.totalSpent + (s.depreciation ?? 0))}
- Cost per month: ${money(s.costPerMonth)}
- Cost per mile: ${s.costPerMile != null ? '$' + s.costPerMile.toFixed(3) : 'n/a'}

RECENT TRANSACTIONS
${recent.map((t: any) => `- ${t.txn_date} ${money(t.amount)} ${t.category ?? ''} ${t.merchant ?? ''} ${t.description ?? ''}`.trim()).join('\n') || '- (none)'}

Cover: where the money goes, whether cost/mile and cost/month look reasonable, any spikes or recurring costs worth attention, and 2-4 concrete suggestions. If key inputs (mileage, current value) are missing, say what to add for a better estimate.`;

    const result = await runAi(prompt);
    await save('vehicle_tco', Number(req.params.id), `Cost of ownership: ${v.name}`, result, bookId);
    res.json({ summary: s, result });
  })
);

// --- Property cost of ownership / rental performance ---
analysis.post(
  '/property/:id/cost-of-ownership',
  ah(async (req, res) => {
    const bookId = hh(req);
    const s = await propertySummary(Number(req.params.id), bookId);
    const p: any = s.property;

    const recent = await query(
      `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
       SELECT eff_tag.txn_date, eff_tag.amount, eff_tag.direction, t.merchant, t.description, c.name AS category
       FROM eff_tag
       JOIN transactions t ON t.id = eff_tag.id
       LEFT JOIN categories c ON c.id = eff_tag.category_id
       WHERE eff_tag.kind = 'property' AND eff_tag.ref_id = $1
         AND eff_tag.book_id = $2
       ORDER BY eff_tag.txn_date DESC LIMIT 60`,
      [req.params.id, bookId]
    );

    const prompt = `Analyze the cost of ownership and (if it's a rental) the rental performance of this property. Be practical.

PROPERTY
- ${p.name} (${p.property_type})${p.address ? ` — ${p.address}` : ''}
- Purchase price: ${money(p.purchase_price)}${p.purchase_date ? ` (bought ${String(p.purchase_date).slice(0, 10)})` : ''}
- Current value: ${money(p.current_value)}
- Mortgage balance: ${money(p.mortgage_balance)}
- Equity: ${money(s.equity)}
- Appreciation since purchase: ${money(s.appreciation)}
- Months owned: ${s.monthsOwned ?? 'n/a'}
- Stated rent: ${p.rental_income != null ? money(p.rental_income) + '/mo (' + money(s.annualRentalIncome) + '/yr)' : 'n/a'}
- Gross yield: ${s.grossYield != null ? (s.grossYield * 100).toFixed(2) + '%' : 'n/a'}

SPENDING BY CATEGORY (expenses tagged to this property)
${s.byCategory.map((c: any) => `- ${c.category_name ?? 'Uncategorized'}: ${money(c.total)} (${c.count} txns)`).join('\n') || '- (none recorded)'}

COMPUTED
- Total spent (tagged expenses): ${money(s.totalSpent)}
- Total income (tagged, e.g. rent received): ${money(s.totalIncome)}
- Net (income − expenses): ${money(s.net)}
- Cost per month (expenses): ${money(s.costPerMonth)}

RECENT TRANSACTIONS
${recent.map((t: any) => `- ${String(t.txn_date).slice(0, 10)} ${t.direction === 'income' ? '+' : '−'}${money(t.amount)} ${t.category ?? ''} ${t.merchant ?? ''} ${t.description ?? ''}`.trim()).join('\n') || '- (none)'}

Cover: where the money goes, whether the property is cash-flow positive, how operating costs compare to rent, whether the yield/appreciation look reasonable, any recurring or spiking costs, and 2-4 concrete suggestions. If key inputs (rent, current value, expenses) are missing, say what to add for a better estimate.`;

    const result = await runAi(prompt);
    await save('property_cost', Number(req.params.id), `Property cost: ${p.name}`, result, bookId);
    res.json({ summary: s, result });
  })
);

// --- Product-level analysis from receipt items ---
analysis.post(
  '/products',
  ah(async (req, res) => {
    const bookId = hh(req);
    // receipt_items aren't tenant-stamped directly; scope via their parent receipt.
    const topProducts = await query(
      `SELECT lower(ri.name) AS product, COUNT(*)::int AS times_bought,
              SUM(ri.total_price) AS total_spent,
              AVG(ri.unit_price) AS avg_unit_price,
              MIN(ri.unit_price) AS min_unit_price,
              MAX(ri.unit_price) AS max_unit_price
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
       WHERE r.book_id = $1
       GROUP BY lower(ri.name)
       ORDER BY total_spent DESC NULLS LAST
       LIMIT 50`,
      [bookId]
    );
    if (topProducts.length === 0) {
      throw new HttpError(400, 'No receipt items yet. Add itemized receipts to transactions first.');
    }
    const byCat = await query(
      `SELECT COALESCE(ri.product_category,'(uncategorized)') AS category,
              SUM(ri.total_price) AS total_spent, COUNT(*)::int AS items
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
       WHERE r.book_id = $1
       GROUP BY ri.product_category ORDER BY total_spent DESC NULLS LAST`,
      [bookId]
    );

    const prompt = `Analyze product-level purchasing behavior from itemized receipts.

TOP PRODUCTS (by total spent)
${topProducts.map((p: any) => `- ${p.product}: bought ${p.times_bought}x, total ${money(p.total_spent)}, unit price avg ${money(p.avg_unit_price)} (range ${money(p.min_unit_price)}–${money(p.max_unit_price)})`).join('\n')}

SPEND BY PRODUCT CATEGORY
${byCat.map((c: any) => `- ${c.category}: ${money(c.total_spent)} across ${c.items} items`).join('\n')}

Identify the biggest spend drivers, products with notable unit-price variation (possible savings from buying differently), frequently repurchased items, and 3-5 specific, actionable suggestions to reduce spend without guessing at data you weren't given.`;

    const result = await runAi(prompt);
    await save('receipt_products', null, 'Product spending analysis', result, bookId);
    res.json({ topProducts, byCategory: byCat, result });
  })
);

// --- Overall spending / budget overview ---
analysis.post(
  '/overview',
  ah(async (req, res) => {
    const bookId = hh(req);
    const since = new Date();
    since.setMonth(since.getMonth() - 3);
    const sinceStr = since.toISOString().slice(0, 10);

    const byCategory = await query(
      `SELECT c.name AS category, t.direction, SUM(t.amount) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.txn_date >= $1 AND t.book_id = $2
       GROUP BY c.name, t.direction ORDER BY total DESC`,
      [sinceStr, bookId]
    );
    // Computed (not snapshot) balances, matching the dashboard/accounts pages.
    const netWorth = await query(
      `WITH ${ACCOUNT_BALANCES}
       SELECT a.name, a.is_liability, ab.posted_balance AS balance
       FROM accounts a JOIN acct_bal ab ON ab.id = a.id
       WHERE a.book_id = $1
       ORDER BY a.is_liability, a.name`,
      [bookId]
    );
    const nw = await computeNetWorth(netWorth as any[], bookId);
    const utils = await query(
      `SELECT ua.utility_type, SUM(l.amount) AS total, COUNT(DISTINCT i.id)::int AS bills
       FROM utility_invoice_lines l
       JOIN utility_invoices i ON i.id = l.invoice_id
       JOIN utility_accounts ua ON ua.id = l.utility_account_id
       WHERE COALESCE(i.period_end, i.due_date, i.invoice_date) >= $1 AND i.book_id = $2
       GROUP BY ua.utility_type ORDER BY total DESC`,
      [sinceStr, bookId]
    );

    const prompt = `Give a personal-finance overview based on the last ~3 months.

CURRENT NET WORTH: ${money(nw)}
Accounts (latest balances):
${netWorth.map((a: any) => `- ${a.name}${a.is_liability ? ' (liability)' : ''}: ${money(a.balance)}`).join('\n')}

SPENDING & INCOME BY CATEGORY (last 3 months)
${byCategory.map((c: any) => `- ${c.category ?? 'Uncategorized'} [${c.direction}]: ${money(c.total)}`).join('\n') || '- (none)'}

UTILITIES (last 3 months)
${utils.map((u: any) => `- ${u.utility_type}: ${money(u.total)} (${u.bills} bills)`).join('\n') || '- (none)'}

Summarize spending patterns, flag the largest discretionary categories, comment on the income-vs-expense balance, and give 3-5 prioritized recommendations.`;

    const result = await runAi(prompt);
    await save('spending_overview', null, 'Spending overview', result, bookId);
    res.json({ netWorth: nw, byCategory, result });
  })
);

// --- Free-form question over a compact data snapshot ---
analysis.post(
  '/custom',
  ah(async (req, res) => {
    // Bound the free-form question before it goes into the prompt (a direct API
    // caller isn't held to the client's input cap).
    const question = requiredString(req.body.question, 'question', { max: 1000 });
    const bookId = hh(req);
    const snapshot = await buildSnapshot(bookId);
    const prompt = `Here is a snapshot of my finances as JSON:

\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\`

Question: ${question}

Answer using only this data. If the data is insufficient, say what additional records I should add.`;
    const result = await runAi(prompt);
    await save('custom', null, question.slice(0, 120), result, bookId);
    res.json({ result });
  })
);

// Net worth on the same computed basis as the dashboard: account balances
// (opening + posted flows) plus vehicles/assets/property values, minus generic
// and property liabilities.
async function computeNetWorth(accountRows: { is_liability: boolean; balance: number | string | null }[], bookId: number): Promise<number> {
  const [v, as_, li, pr] = await Promise.all([
    query(`SELECT COALESCE(SUM(current_value),0) AS total FROM vehicles WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]),
    query(`SELECT COALESCE(SUM(value),0) AS total FROM assets WHERE book_id = $1`, [bookId]),
    query(`SELECT COALESCE(SUM(balance),0) AS total FROM liabilities WHERE book_id = $1`, [bookId]),
    query(`SELECT COALESCE(SUM(current_value),0) AS av, COALESCE(SUM(mortgage_balance) FILTER (WHERE mortgage_account_id IS NULL),0) AS lv FROM properties WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]),
  ]);
  const accAssets = accountRows.filter((a) => !a.is_liability).reduce((s, a) => s + Number(a.balance ?? 0), 0);
  const accLiabs = accountRows.filter((a) => a.is_liability).reduce((s, a) => s + Number(a.balance ?? 0), 0);
  const assets = accAssets + Number((v[0] as any).total) + Number((as_[0] as any).total) + Number((pr[0] as any).av);
  const liabs = accLiabs + Number((li[0] as any).total) + Number((pr[0] as any).lv);
  return round2(assets - liabs);
}

async function buildSnapshot(bookId: number) {
  const [accounts, categoryTotals, vehicles, utilities] = await Promise.all([
    query(`WITH ${ACCOUNT_BALANCES}
           SELECT a.name, a.type, a.is_liability, ab.posted_balance AS latest_balance
           FROM accounts a JOIN acct_bal ab ON ab.id = a.id WHERE a.book_id = $1`, [bookId]),
    query(`SELECT c.name AS category, t.direction, SUM(t.amount) AS total, COUNT(*)::int AS count
           FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
           WHERE t.book_id = $1
           GROUP BY c.name, t.direction ORDER BY total DESC LIMIT 40`, [bookId]),
    query(`SELECT name, make, model, year, purchase_price, current_value FROM vehicles WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]),
    query(`SELECT ua.utility_type, SUM(l.amount) AS total, AVG(l.usage_quantity) AS avg_usage, l.usage_unit
           FROM utility_invoice_lines l
           JOIN utility_accounts ua ON ua.id = l.utility_account_id
           WHERE ua.book_id = $1
           GROUP BY ua.utility_type, l.usage_unit`, [bookId]),
  ]);
  return { accounts, categoryTotals, vehicles, utilities };
}

async function runAi(prompt: string): Promise<string> {
  try {
    return await ask(prompt);
  } catch (e) {
    if (e instanceof AiNotConfiguredError) throw new HttpError(503, e.message);
    throw e;
  }
}
