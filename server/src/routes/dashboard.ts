import { Router } from 'express';
import { query } from '../db.js';
import { ah } from '../http.js';
import { ACCOUNT_BALANCES, EFFECTIVE_LINES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { round2 } from '../validation.js';

export const dashboard = Router();

dashboard.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const accounts = await query(`
      WITH ${ACCOUNT_BALANCES}
      SELECT a.id, a.name, a.type, a.is_liability,
             ab.posted_balance AS latest_balance, ab.pending_balance
      FROM accounts a JOIN acct_bal ab ON ab.id = a.id
      WHERE a.book_id = $1
      ORDER BY a.is_liability, a.name
    `, [bookId]);

    // Beyond accounts, net worth also includes vehicles, generic assets, and
    // generic liabilities (their current values; only accounts have history).
    const [vehicleRows, assetRows, liabRows, propRows] = await Promise.all([
      query(`SELECT COALESCE(SUM(current_value),0) AS total FROM vehicles WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]),
      query(`SELECT COALESCE(SUM(value),0) AS total FROM assets WHERE book_id = $1`, [bookId]),
      query(`SELECT COALESCE(SUM(balance),0) AS total FROM liabilities WHERE book_id = $1`, [bookId]),
      query(`SELECT COALESCE(SUM(current_value),0) AS av, COALESCE(SUM(mortgage_balance) FILTER (WHERE mortgage_account_id IS NULL),0) AS lv FROM properties WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]),
    ]);
    const vehicleTotal = Number((vehicleRows[0] as any).total);
    const otherAssetTotal = Number((assetRows[0] as any).total);
    const otherLiabTotal = Number((liabRows[0] as any).total);
    const propertyAssetTotal = Number((propRows[0] as any).av);
    const propertyLiabTotal = Number((propRows[0] as any).lv);

    const accountAssets = accounts
      .filter((a: any) => !a.is_liability)
      .reduce((s, a: any) => s + Number(a.latest_balance ?? 0), 0);
    const accountLiabs = accounts
      .filter((a: any) => a.is_liability)
      .reduce((s, a: any) => s + Number(a.latest_balance ?? 0), 0);

    const assets = round2(accountAssets + vehicleTotal + otherAssetTotal + propertyAssetTotal);
    const liabilities = round2(accountLiabs + otherLiabTotal + propertyLiabTotal);
    const netWorth = round2(assets - liabilities);

    // Net-worth history derived from posted transaction flows: each date's net
    // worth = current net worth minus the net flows that happened after it.
    // (Transfers net to zero, so they don't move net worth.) Anchored so the
    // latest point equals the headline net worth above.
    const flows = await query(`
      SELECT txn_date AS date,
             SUM(CASE direction WHEN 'income' THEN amount WHEN 'expense' THEN -amount ELSE 0 END)::float8 AS net
      FROM transactions WHERE posted_date IS NOT NULL AND book_id = $1
      GROUP BY txn_date ORDER BY txn_date
    `, [bookId]);
    const totalFlow = flows.reduce((s, f: any) => s + Number(f.net), 0);
    let cum = 0;
    const series = flows.map((f: any) => {
      cum += Number(f.net);
      return { date: f.date, net_worth: round2(netWorth - (totalFlow - cum)) };
    });

    // This calendar month spending / income
    const monthFlow = await query(`
      SELECT direction, SUM(amount) AS total
      FROM transactions
      WHERE date_trunc('month', txn_date) = date_trunc('month', CURRENT_DATE) AND book_id = $1
      GROUP BY direction
    `, [bookId]);

    const recent = await query(`
      SELECT t.*, c.name AS category_name, a.name AS account_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.book_id = $1
      ORDER BY t.txn_date DESC, t.id DESC LIMIT 10
    `, [bookId]);

    // This-month spending grouped by category (top buckets) — a snapshot of where
    // money is going, without surfacing individual transactions. Uses the effective
    // -line view so split transactions are attributed to each split's category
    // (matching budgets/goals), not lumped under the parent or "Uncategorized".
    const categorySpend = await query(`
      WITH ${EFFECTIVE_LINES}
      SELECT COALESCE(c.name, 'Uncategorized') AS name, SUM(eff.amount)::float8 AS total
      FROM eff LEFT JOIN categories c ON c.id = eff.category_id
      WHERE eff.direction = 'expense'
        AND date_trunc('month', eff.txn_date) = date_trunc('month', CURRENT_DATE)
        AND eff.book_id = $1
      GROUP BY COALESCE(c.name, 'Uncategorized')
      ORDER BY total DESC LIMIT 8
    `, [bookId]);

    res.json({ netWorth, assets, liabilities, series, accounts, monthFlow, recent, categorySpend });
  })
);
