import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh } from '../tenant.js';

// Reporting over receipt line items: spend by category over time, top products, and a
// per-product price history (price-per-unit-of-measure). All queries are scoped to the
// book both by RLS and an explicit book_id filter.
export const receiptItems = Router();

const clampInt = (v: any, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
};

// Summary cards + category breakdown + spend-over-time (pivoted by category per month).
receiptItems.get('/overview', ah(async (req, res) => {
  const bookId = hh(req);
  const months = clampInt(req.query.months, 1, 36, 12);

  const totals = await one<any>(
    `SELECT COALESCE(SUM(ri.total_price),0)::float8 AS total_spend,
            COUNT(*)::int AS item_count,
            COUNT(DISTINCT lower(ri.name))::int AS product_count,
            to_char(MIN(r.purchased_at),'YYYY-MM-DD') AS first_date,
            to_char(MAX(r.purchased_at),'YYYY-MM-DD') AS last_date
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
      WHERE ri.book_id = $1 AND ri.total_price IS NOT NULL`,
    [bookId]
  );

  const byCategory = await query<any>(
    `SELECT COALESCE(ri.category,'Uncategorized') AS category,
            SUM(ri.total_price)::float8 AS spend, COUNT(*)::int AS items
       FROM receipt_items ri
      WHERE ri.book_id = $1 AND ri.total_price IS NOT NULL
      GROUP BY 1 ORDER BY spend DESC`,
    [bookId]
  );

  const monthRows = await query<any>(
    `SELECT to_char(date_trunc('month', r.purchased_at),'YYYY-MM') AS month,
            COALESCE(ri.category,'Uncategorized') AS category,
            SUM(ri.total_price)::float8 AS spend
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
      WHERE ri.book_id = $1 AND ri.total_price IS NOT NULL AND r.purchased_at IS NOT NULL
        AND r.purchased_at >= (date_trunc('month', CURRENT_DATE) - (($2)::text || ' months')::interval)
      GROUP BY 1, 2 ORDER BY 1`,
    [bookId, months - 1]
  );

  // Pivot the flat (month, category, spend) rows into one record per month for charting.
  const byMonthMap = new Map<string, any>();
  for (const r of monthRows) {
    let m = byMonthMap.get(r.month);
    if (!m) { m = { month: r.month, total: 0 }; byMonthMap.set(r.month, m); }
    m[r.category] = (m[r.category] ?? 0) + r.spend;
    m.total += r.spend;
  }
  const byMonth = [...byMonthMap.values()].sort((a, b) => (a.month < b.month ? -1 : 1));

  res.json({
    ...(totals ?? { total_spend: 0, item_count: 0, product_count: 0, first_date: null, last_date: null }),
    categories: byCategory.map((c) => c.category),
    by_category: byCategory,
    by_month: byMonth,
  });
}));

// Top products by spend, grouped by normalized name. Includes first/last price-per-unit
// so the UI can flag products that got cheaper/pricier.
receiptItems.get('/products', ah(async (req, res) => {
  const bookId = hh(req);
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const offset = clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const category = typeof req.query.category === 'string' && req.query.category.trim() ? req.query.category.trim() : null;
  const params: any[] = [bookId, limit, offset];
  if (category) params.push(category);
  const products = await query<any>(
    `SELECT MIN(ri.name) AS name,
            (array_agg(ri.brand    ORDER BY r.purchased_at DESC NULLS LAST) FILTER (WHERE ri.brand    IS NOT NULL))[1] AS brand,
            (array_agg(ri.category ORDER BY r.purchased_at DESC NULLS LAST) FILTER (WHERE ri.category IS NOT NULL))[1] AS category,
            (array_agg(ri.unit     ORDER BY r.purchased_at DESC NULLS LAST) FILTER (WHERE ri.unit     IS NOT NULL))[1] AS unit,
            COUNT(*)::int AS purchases,
            SUM(ri.quantity)::float8 AS total_qty,
            SUM(ri.total_price)::float8 AS total_spend,
            AVG(ri.uom_price)::float8 AS avg_uom_price,
            (array_agg(ri.uom_price ORDER BY r.purchased_at ASC)  FILTER (WHERE ri.uom_price IS NOT NULL))[1] AS first_uom_price,
            (array_agg(ri.uom_price ORDER BY r.purchased_at DESC) FILTER (WHERE ri.uom_price IS NOT NULL))[1] AS last_uom_price,
            to_char(MAX(r.purchased_at),'YYYY-MM-DD') AS last_purchased
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
      WHERE ri.book_id = $1 AND ri.total_price IS NOT NULL ${category ? 'AND ri.category = $4' : ''}
      GROUP BY lower(ri.name)
      ORDER BY total_spend DESC
      LIMIT $2 OFFSET $3`,
    params
  );
  // Total distinct products (the grouped-by set) over the full book, for paging.
  const cnt = await one<{ n: number }>(
    `SELECT COUNT(DISTINCT lower(ri.name))::int AS n
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
      WHERE ri.book_id = $1 AND ri.total_price IS NOT NULL ${category ? 'AND ri.category = $2' : ''}`,
    category ? [bookId, category] : [bookId]
  );
  const total = Number(cnt?.n ?? 0);
  res.json({ products, total });
}));

// One product's purchase history (for the price-per-unit trend + buy log).
receiptItems.get('/product', ah(async (req, res) => {
  const bookId = hh(req);
  const name = String(req.query.name ?? '').trim();
  if (!name) throw new HttpError(400, 'A product name is required.');
  const rows = await query<any>(
    `SELECT to_char(r.purchased_at,'YYYY-MM-DD') AS date, r.merchant AS store,
            ri.quantity::float8 AS quantity, ri.total_price::float8 AS total_price,
            ri.uom_price::float8 AS uom_price, ri.size::float8 AS size, ri.unit, ri.brand
       FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
      WHERE ri.book_id = $1 AND lower(ri.name) = lower($2) AND r.purchased_at IS NOT NULL
      ORDER BY r.purchased_at`,
    [bookId, name]
  );
  res.json(rows);
}));
