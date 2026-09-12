// A CTE that yields one "line" per transaction split, or the whole transaction
// when it has no splits. Use it in place of `transactions` for category
// aggregations (budgets) so that split transactions are attributed to their
// parts. `split_id` is the split's id (NULL for whole-transaction lines) and is
// used to attach line-level tags — see EFFECTIVE_LINE_TAGS. Prepend with WITH
// and reference the `eff` alias, e.g.  `WITH ${EFFECTIVE_LINES} SELECT ... FROM eff ...`.
export const EFFECTIVE_LINES = `
  eff AS (
    -- Split lines. On a transfer, principal lines are balance movements (not a
    -- cost) so they're excluded; the other lines (interest/escrow/fees) count as
    -- expenses. Non-transfer splits keep the parent's direction unchanged.
    SELECT s.transaction_id AS id, s.id AS split_id, t.txn_date,
           CASE WHEN t.direction = 'transfer' THEN 'expense' ELSE t.direction END AS direction,
           t.account_id, t.posted_date, s.amount, s.category_id, t.book_id
    FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id AND s.book_id = t.book_id
    WHERE NOT (t.direction = 'transfer' AND s.is_principal)
    UNION ALL
    SELECT t.id, NULL::int AS split_id, t.txn_date, t.direction,
           t.account_id, t.posted_date, t.amount, t.category_id, t.book_id
    FROM transactions t
    WHERE NOT EXISTS (SELECT 1 FROM transaction_splits ss WHERE ss.transaction_id = t.id AND ss.book_id = t.book_id)
    UNION ALL
    -- Legacy single-field path (transfers with a principal_amount but no split
    -- breakdown): the interest remainder surfaces as one expense line under
    -- interest_category_id. Skipped when the transfer has splits (handled above).
    SELECT t.id, NULL::int AS split_id, t.txn_date, 'expense'::text AS direction,
           t.account_id, t.posted_date, (t.amount - t.principal_amount) AS amount,
           t.interest_category_id AS category_id, t.book_id
    FROM transactions t
    WHERE t.direction = 'transfer' AND t.principal_amount IS NOT NULL AND t.amount > t.principal_amount
      AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.book_id = t.book_id)
  )
`;

// Expands `eff` to one row per (line, tag) for vehicle/property/subscription
// rollups, since a line can now carry any number of tags. Must be composed
// after EFFECTIVE_LINES in the same WITH, e.g.
//   `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
//    SELECT SUM(amount) FROM eff_tag WHERE kind = 'vehicle' AND ref_id = $1`.
// A line tagged with two vehicles contributes its full amount to each — the
// purchase genuinely relates to both.
export const EFFECTIVE_LINE_TAGS = `
  eff_tag AS (
    SELECT eff.*, lt.kind, lt.ref_id
    FROM eff
    JOIN line_tags lt
      ON lt.book_id = eff.book_id
     AND ((eff.split_id IS NOT NULL AND lt.split_id = eff.split_id)
       OR (eff.split_id IS NULL AND lt.transaction_id = eff.id AND lt.split_id IS NULL))
  )
`;

// A CTE `acct_bal` with each account's computed posted_balance and pending_balance.
// The anchor is the latest dated balance snapshot (account_balances), or the
// account's opening_balance when there are no snapshots. Balance = anchor +
// (liability ? -1 : 1) * Σ signed deltas for transactions AFTER the anchor date
// (income = +amount, expense/transfer-out = -amount, transfer-in = +amount).
//   posted_balance  = anchor + posted deltas dated AFTER the anchor (cleared since
//                     the snapshot; ones on/before are already reflected in it).
//   pending_balance = posted_balance + ALL not-yet-posted deltas (any date) — an
//                     un-posted transaction hasn't cleared, so it isn't in the
//                     snapshot regardless of its date.
// With no snapshot the anchor is opening_balance and all transactions count.
export const ACCOUNT_BALANCES = `
  acct_bal AS (
    SELECT a.id, a.book_id,
      anc.bal + (CASE WHEN a.is_liability THEN -1 ELSE 1 END) * COALESCE(d.posted, 0)  AS posted_balance,
      anc.bal + (CASE WHEN a.is_liability THEN -1 ELSE 1 END) * (COALESCE(d.posted, 0) + COALESCE(d.pending_extra, 0)) AS pending_balance
    FROM accounts a
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT s.balance FROM account_balances s WHERE s.account_id = a.id AND s.book_id = a.book_id ORDER BY s.as_of DESC LIMIT 1), a.opening_balance) AS bal,
        (SELECT s.as_of FROM account_balances s WHERE s.account_id = a.id AND s.book_id = a.book_id ORDER BY s.as_of DESC LIMIT 1) AS dt
    ) anc
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(delta) FILTER (WHERE is_posted AND (anc.dt IS NULL OR txn_date > anc.dt)), 0) AS posted,
        COALESCE(SUM(delta) FILTER (WHERE NOT is_posted), 0) AS pending_extra
      FROM (
        SELECT (t.posted_date IS NOT NULL) AS is_posted, t.txn_date,
               CASE t.direction WHEN 'income' THEN t.amount ELSE -t.amount END AS delta
        FROM transactions t WHERE t.account_id = a.id AND t.book_id = a.book_id
        UNION ALL
        -- Transfer in: only the principal portion reduces a loan. With a split
        -- breakdown, that's the sum of the lines flagged is_principal; otherwise
        -- the legacy principal_amount, or the full amount for a plain transfer.
        SELECT (t.posted_date IS NOT NULL) AS is_posted, t.txn_date,
               CASE
                 WHEN EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.book_id = t.book_id)
                   THEN COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id AND s.book_id = t.book_id AND s.is_principal), 0)
                 ELSE COALESCE(t.principal_amount, t.amount)
               END AS delta
        FROM transactions t WHERE t.direction = 'transfer' AND t.transfer_account_id = a.id AND t.book_id = a.book_id
      ) x
    ) d ON TRUE
  )
`;
