import { Router } from 'express';
import { query } from '../db.js';
import { ah } from '../http.js';
import { ACCOUNT_BALANCES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { round2 } from '../validation.js';

export const networth = Router();

// Human labels for the type codes used across accounts / assets / liabilities.
const LABELS: Record<string, string> = {
  // account types
  checking: 'Checking', savings: 'Savings', credit_card: 'Credit card',
  hsa: 'HSA', fsa: 'FSA', money_market: 'Money market', cd: 'CD',
  retirement: 'Retirement', brokerage: 'Brokerage', crypto: 'Crypto',
  investment: 'Investment', loan: 'Loan', cash: 'Cash', asset: 'Asset', other: 'Other',
  // asset types
  property: 'Property', rv: 'RVs', airplane: 'Airplanes', boat: 'Boats',
  equipment: 'Equipment', collectible: 'Collectibles',
  // liability types
  mortgage: 'Mortgages', auto_loan: 'Auto loans', student_loan: 'Student loans',
  personal_loan: 'Personal loans', medical: 'Medical debt',
};
const label = (t: string) => LABELS[t] ?? t;

// Money sums cross the boundary as JS floats (see db.ts), so round each total to
// whole cents — group totals and the headline net-worth number must not leak
// sub-cent float noise that grows with the number of rows summed.
const sum = <T,>(arr: T[], f: (x: T) => any) =>
  round2(arr.reduce((s, x) => s + Number(f(x) ?? 0), 0));

function groupBy<T>(arr: T[], key: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of arr) (out[key(x)] ??= []).push(x);
  return out;
}

// Account net-worth history computed from dated balance FACTS (the
// account_balance_events ledger, backfilled from account_balances) rather than
// from current balance minus transaction flows. For each date that has a balance
// fact, each account contributes its most-recent balance as of that date
// (liabilities negative), falling back to opening_balance when it has no event
// yet. Empty when no events exist (graceful fallback for fresh installs).
networth.get(
  '/history',
  ah(async (req, res) => {
    const bookId = hh(req);
    const series = await query(
      `SELECT to_char(d.as_of, 'YYYY-MM-DD') AS date,
              SUM((CASE WHEN a.is_liability THEN -1 ELSE 1 END) * COALESCE(
                (SELECT e.balance FROM account_balance_events e
                  WHERE e.account_id = a.id AND e.as_of <= d.as_of AND e.voided_at IS NULL
                  ORDER BY e.as_of DESC, e.id DESC LIMIT 1),
                a.opening_balance, 0))::float8 AS net_worth
       -- Date axis bucketed to one point per month (the latest fact date in that
       -- month) so a daily-synced account can't blow the series up to thousands of
       -- dates × entities. A month with a single fact is unchanged.
       FROM (SELECT max(as_of) AS as_of FROM account_balance_events WHERE book_id = $1 AND voided_at IS NULL
              GROUP BY date_trunc('month', as_of)) d
       CROSS JOIN accounts a
       WHERE a.book_id = $1
       GROUP BY d.as_of
       ORDER BY d.as_of`,
      [bookId]
    );
    res.json({ series });
  })
);

// Total ASSET value over time — accounts (balance-event ledger) plus property /
// vehicle / other-asset value snapshots, each forward-filled to the most recent
// value as of each date (falling back to the current value when no snapshot yet).
// Liabilities are excluded. Empty when there's no dated data (graceful fallback).
networth.get(
  '/asset-history',
  ah(async (req, res) => {
    const bookId = hh(req);
    const series = await query(
      `WITH dates AS (
         -- One bucketed point per month (the latest fact date that month).
         SELECT max(as_of) AS as_of FROM (
           SELECT as_of FROM account_balance_events WHERE book_id = $1 AND voided_at IS NULL
           UNION SELECT as_of FROM property_values WHERE book_id = $1
           UNION SELECT as_of FROM vehicle_values  WHERE book_id = $1
           UNION SELECT as_of FROM asset_values    WHERE book_id = $1
         ) x GROUP BY date_trunc('month', as_of)
       )
       SELECT to_char(d.as_of, 'YYYY-MM-DD') AS date,
         (
           (SELECT COALESCE(SUM(COALESCE(
              (SELECT e.balance FROM account_balance_events e
                WHERE e.account_id = a.id AND e.as_of <= d.as_of AND e.voided_at IS NULL
                ORDER BY e.as_of DESC, e.id DESC LIMIT 1),
              a.opening_balance, 0)), 0)
            FROM accounts a WHERE a.book_id = $1 AND NOT a.is_liability)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT v.value FROM property_values v WHERE v.property_id = p.id AND v.as_of <= d.as_of ORDER BY v.as_of DESC, v.id DESC LIMIT 1),
              p.current_value, 0)), 0)
            FROM properties p WHERE p.book_id = $1 AND p.disposed_at IS NULL)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT v.value FROM vehicle_values v WHERE v.vehicle_id = ve.id AND v.as_of <= d.as_of ORDER BY v.as_of DESC, v.id DESC LIMIT 1),
              ve.current_value, 0)), 0)
            FROM vehicles ve WHERE ve.book_id = $1 AND ve.disposed_at IS NULL)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT v.value FROM asset_values v WHERE v.asset_id = ast.id AND v.as_of <= d.as_of ORDER BY v.as_of DESC, v.id DESC LIMIT 1),
              ast.value, 0)), 0)
            FROM assets ast WHERE ast.book_id = $1)
         )::float8 AS value
       FROM dates d ORDER BY d.as_of`,
      [bookId]
    );
    res.json({ series });
  })
);

// Total LIABILITY balance over time — liability accounts (balance-event ledger,
// owed amounts) plus a flat baseline for unlinked property mortgages and standalone
// liabilities (which carry no dated history). Empty when there's no dated data.
networth.get(
  '/liability-history',
  ah(async (req, res) => {
    const bookId = hh(req);
    const series = await query(
      `WITH dates AS (
         -- One bucketed point per month (the latest fact date that month).
         SELECT max(as_of) AS as_of FROM (
           SELECT as_of FROM account_balance_events WHERE book_id = $1 AND voided_at IS NULL
           UNION SELECT as_of FROM liability_balances WHERE book_id = $1
         ) x GROUP BY date_trunc('month', as_of)
       )
       SELECT to_char(d.as_of, 'YYYY-MM-DD') AS date,
         (
           (SELECT COALESCE(SUM(COALESCE(
              (SELECT e.balance FROM account_balance_events e
                WHERE e.account_id = a.id AND e.as_of <= d.as_of AND e.voided_at IS NULL
                ORDER BY e.as_of DESC, e.id DESC LIMIT 1),
              a.opening_balance, 0)), 0)
            FROM accounts a WHERE a.book_id = $1 AND a.is_liability)
         + (SELECT COALESCE(SUM(p.mortgage_balance), 0) FROM properties p
            WHERE p.book_id = $1 AND p.disposed_at IS NULL AND p.mortgage_account_id IS NULL AND COALESCE(p.mortgage_balance, 0) > 0)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT b.balance FROM liability_balances b WHERE b.liability_id = l.id AND b.as_of <= d.as_of ORDER BY b.as_of DESC, b.id DESC LIMIT 1),
              l.balance, 0)), 0)
            FROM liabilities l WHERE l.book_id = $1)
         )::float8 AS value
       FROM dates d ORDER BY d.as_of`,
      [bookId]
    );
    res.json({ series });
  })
);

// Unified NET-WORTH over time — one snapshot-based series combining every asset
// and liability source on a common date axis. For each date that any source has a
// fact, assets (accounts + property/vehicle/asset values, forward-filled) minus
// liabilities (liability accounts + standalone liabilities forward-filled + flat
// unlinked property-mortgage baseline) gives net worth. This is the same
// methodology as /asset-history and /liability-history, fused so the Dashboard
// hero is consistent with the Asset/Liability dashboards. Empty when no dated
// data exists (the Dashboard then falls back to the flow-derived series).
networth.get(
  '/over-time',
  ah(async (req, res) => {
    const bookId = hh(req);
    const series = await query(
      `WITH dates AS (
         -- One bucketed point per month (the latest fact date that month).
         SELECT max(as_of) AS as_of FROM (
           SELECT as_of FROM account_balance_events WHERE book_id = $1 AND voided_at IS NULL
           UNION SELECT as_of FROM property_values   WHERE book_id = $1
           UNION SELECT as_of FROM vehicle_values    WHERE book_id = $1
           UNION SELECT as_of FROM asset_values      WHERE book_id = $1
           UNION SELECT as_of FROM liability_balances WHERE book_id = $1
         ) x GROUP BY date_trunc('month', as_of)
       )
       SELECT to_char(d.as_of, 'YYYY-MM-DD') AS date,
         (
           (SELECT COALESCE(SUM(COALESCE(
              (SELECT e.balance FROM account_balance_events e
                WHERE e.account_id = a.id AND e.as_of <= d.as_of AND e.voided_at IS NULL
                ORDER BY e.as_of DESC, e.id DESC LIMIT 1),
              a.opening_balance, 0)), 0)
            FROM accounts a WHERE a.book_id = $1 AND NOT a.is_liability)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT v.value FROM property_values v WHERE v.property_id = p.id AND v.as_of <= d.as_of ORDER BY v.as_of DESC, v.id DESC LIMIT 1),
              p.current_value, 0)), 0)
            FROM properties p WHERE p.book_id = $1 AND p.disposed_at IS NULL)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT v.value FROM vehicle_values v WHERE v.vehicle_id = ve.id AND v.as_of <= d.as_of ORDER BY v.as_of DESC, v.id DESC LIMIT 1),
              ve.current_value, 0)), 0)
            FROM vehicles ve WHERE ve.book_id = $1 AND ve.disposed_at IS NULL)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT v.value FROM asset_values v WHERE v.asset_id = ast.id AND v.as_of <= d.as_of ORDER BY v.as_of DESC, v.id DESC LIMIT 1),
              ast.value, 0)), 0)
            FROM assets ast WHERE ast.book_id = $1)
         )::float8 AS assets,
         (
           (SELECT COALESCE(SUM(COALESCE(
              (SELECT e.balance FROM account_balance_events e
                WHERE e.account_id = a.id AND e.as_of <= d.as_of AND e.voided_at IS NULL
                ORDER BY e.as_of DESC, e.id DESC LIMIT 1),
              a.opening_balance, 0)), 0)
            FROM accounts a WHERE a.book_id = $1 AND a.is_liability)
         + (SELECT COALESCE(SUM(p.mortgage_balance), 0) FROM properties p
            WHERE p.book_id = $1 AND p.disposed_at IS NULL AND p.mortgage_account_id IS NULL AND COALESCE(p.mortgage_balance, 0) > 0)
         + (SELECT COALESCE(SUM(COALESCE(
              (SELECT b.balance FROM liability_balances b WHERE b.liability_id = l.id AND b.as_of <= d.as_of ORDER BY b.as_of DESC, b.id DESC LIMIT 1),
              l.balance, 0)), 0)
            FROM liabilities l WHERE l.book_id = $1)
         )::float8 AS liabilities
       FROM dates d ORDER BY d.as_of`,
      [bookId]
    );
    // Derive net_worth in JS so the row shape stays flat for the chart; round to
    // cents so float8 sums of NUMERIC don't surface sub-cent noise to the client.
    res.json({ series: series.map((r: any) => ({ date: r.date, assets: round2(r.assets), liabilities: round2(r.liabilities), net_worth: round2(r.assets - r.liabilities) })) });
  })
);

// Monthly CASH-FLOW trend — income vs. expense vs. net per calendar month, from
// posted transactions (transfers excluded, they net to zero). The income statement
// over time, complementing the balance-sheet-over-time series above. Months with
// no activity are omitted; the client fills any gaps it needs for a continuous axis.
networth.get(
  '/cash-flow',
  ah(async (req, res) => {
    const bookId = hh(req);
    const months = Math.min(Math.max(parseInt(String(req.query.months ?? '12'), 10) || 12, 1), 60);
    const series = await query(
      `SELECT to_char(date_trunc('month', txn_date), 'YYYY-MM') AS month,
              SUM(amount) FILTER (WHERE direction = 'income')::float8  AS income,
              SUM(amount) FILTER (WHERE direction = 'expense')::float8 AS expense
       FROM transactions
       WHERE book_id = $1
         AND direction IN ('income', 'expense')
         AND txn_date >= date_trunc('month', CURRENT_DATE) - ($2::int - 1) * INTERVAL '1 month'
       GROUP BY date_trunc('month', txn_date)
       ORDER BY date_trunc('month', txn_date)`,
      [bookId, months]
    );
    res.json({
      series: series.map((r: any) => {
        const income = round2(Number(r.income ?? 0));
        const expense = round2(Number(r.expense ?? 0));
        return { month: r.month, income, expense, net: round2(income - expense) };
      }),
    });
  })
);

// Aggregated net-worth breakdown across every source of assets and liabilities.
networth.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const accounts = await query(`
      WITH ${ACCOUNT_BALANCES}
      SELECT a.id, a.name, a.type, a.is_liability, ab.posted_balance AS balance
      FROM accounts a JOIN acct_bal ab ON ab.id = a.id
      WHERE a.book_id = $1
    `, [bookId]);
    const vehicles = await query(`SELECT id, name, current_value FROM vehicles WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]);
    const assets = await query(`SELECT * FROM assets WHERE book_id = $1`, [bookId]);
    const liabs = await query(`SELECT * FROM liabilities WHERE book_id = $1`, [bookId]);
    const props = await query(`SELECT id, name, current_value, mortgage_balance, mortgage_account_id FROM properties WHERE book_id = $1 AND disposed_at IS NULL`, [bookId]);

    const accountAssets = accounts.filter((a: any) => !a.is_liability);
    const accountLiabs = accounts.filter((a: any) => a.is_liability);

    // ----- Asset groups -----
    const assetGroups: any[] = [
      { type: 'account', label: 'Accounts', total: sum(accountAssets, (a: any) => a.balance), count: accountAssets.length },
      { type: 'property', label: 'Properties', total: sum(props, (p: any) => p.current_value), count: props.length },
      { type: 'vehicle', label: 'Vehicles', total: sum(vehicles, (v: any) => v.current_value), count: vehicles.length },
    ];
    for (const [t, list] of Object.entries(groupBy(assets, (a: any) => a.asset_type))) {
      assetGroups.push({ type: t, label: label(t), total: sum(list, (a: any) => a.value), count: list.length });
    }

    // ----- Liability groups (account-based + generic + property mortgages) -----
    const liabilityGroups: any[] = [];
    for (const [t, list] of Object.entries(groupBy(accountLiabs, (a: any) => a.type))) {
      liabilityGroups.push({ type: `account:${t}`, label: `${label(t)} (account)`, total: sum(list, (a: any) => a.balance), count: list.length });
    }
    // A mortgage linked to an account is counted via that liability account, not here.
    const propsWithMortgage = props.filter((p: any) => Number(p.mortgage_balance ?? 0) > 0 && !p.mortgage_account_id);
    if (propsWithMortgage.length) {
      liabilityGroups.push({ type: 'property_mortgage', label: 'Property mortgages', total: sum(propsWithMortgage, (p: any) => p.mortgage_balance), count: propsWithMortgage.length });
    }
    for (const [t, list] of Object.entries(groupBy(liabs, (l: any) => l.liability_type))) {
      liabilityGroups.push({ type: t, label: label(t), total: sum(list, (l: any) => l.balance), count: list.length });
    }

    const totalAssets = sum(assetGroups, (g) => g.total);
    const totalLiabilities = sum(liabilityGroups, (g) => g.total);

    res.json({
      totals: { assets: totalAssets, liabilities: totalLiabilities, netWorth: round2(totalAssets - totalLiabilities) },
      assetGroups: assetGroups.filter((g) => g.count > 0),
      liabilityGroups,
      assets,
      liabilities: liabs,
    });
  })
);
