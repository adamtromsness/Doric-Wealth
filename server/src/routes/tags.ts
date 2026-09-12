import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { EFFECTIVE_LINES, EFFECTIVE_LINE_TAGS } from '../effectiveLines.js';

export const tags = Router();

// All of the book's tags (active + archived). The client filters active
// ones for pickers; the management page shows everything.
tags.get(
  '/',
  ah(async (req, res) => {
    res.json(await query(
      `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS},
         counts AS (
           SELECT ref_id, COUNT(DISTINCT id)::int AS txn_count
           FROM eff_tag WHERE kind = 'tag' AND book_id = $1
           GROUP BY ref_id
         )
       SELECT t.id, t.name, t.description, t.archived, t.sort_order,
              COALESCE(c.txn_count, 0) AS txn_count
       FROM tags t
       LEFT JOIN counts c ON c.ref_id = t.id
       WHERE t.book_id = $1
       ORDER BY t.archived ASC, t.sort_order, lower(t.name)`,
      [hh(req)]
    ));
  })
);

tags.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, 'A tag name is required.');
    const description = req.body.description != null ? String(req.body.description).trim() || null : null;
    try {
      const row = await one(
        `INSERT INTO tags (name, description, book_id) VALUES ($1, $2, $3)
         RETURNING id, name, description, archived, sort_order`,
        [name, description, hh(req)]
      );
      res.status(201).json(row);
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'A tag with that name already exists.');
      throw e;
    }
  })
);

tags.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body ?? {};
    const name = b.name != null ? String(b.name).trim() : null;
    if (name === '') throw new HttpError(400, 'A tag name is required.');
    const archived = typeof b.archived === 'boolean' ? b.archived : null;
    // description: present key (even empty) => set; absent => leave unchanged.
    const setDescription = 'description' in b;
    const description = setDescription ? (String(b.description ?? '').trim() || null) : null;
    try {
      const row = await one(
        `UPDATE tags
            SET name = COALESCE($2, name),
                archived = COALESCE($3, archived),
                description = CASE WHEN $5 THEN $4 ELSE description END
          WHERE id = $1 AND book_id = $6
        RETURNING id, name, description, archived, sort_order`,
        [req.params.id, name, archived, description, setDescription, hh(req)]
      );
      if (!row) throw new HttpError(404, 'Tag not found');
      res.json(row);
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'A tag with that name already exists.');
      throw e;
    }
  })
);

// Per-tag report: totals, a category breakdown, a monthly breakdown, and the
// tagged transactions. Amounts are split-aware (a line tagged with this tag
// contributes its own amount) via the shared eff_tag CTE.
tags.get(
  '/:id/report',
  ah(async (req, res) => {
    const bookId = hh(req);
    const id = Number(req.params.id);
    const tag = await one(
      `SELECT id, name, description, archived FROM tags WHERE id = $1 AND book_id = $2`,
      [id, bookId]
    );
    if (!tag) throw new HttpError(404, 'Tag not found');

    const totals = await one(`
      WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction = 'expense'), 0) AS expense,
        COALESCE(SUM(amount) FILTER (WHERE direction = 'income'), 0)  AS income,
        COUNT(*)::int AS lines,
        to_char(MIN(txn_date), 'YYYY-MM-DD') AS first_date,
        to_char(MAX(txn_date), 'YYYY-MM-DD') AS last_date
      FROM eff_tag
      WHERE kind = 'tag' AND ref_id = $1 AND book_id = $2`,
      [id, bookId]
    );

    const byCategory = await query(`
      WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
      SELECT c.name AS category_name, COALESCE(SUM(eff_tag.amount), 0) AS total, COUNT(*)::int AS count
      FROM eff_tag LEFT JOIN categories c ON c.id = eff_tag.category_id
      WHERE eff_tag.kind = 'tag' AND eff_tag.ref_id = $1 AND eff_tag.book_id = $2
        AND eff_tag.direction = 'expense'
      GROUP BY c.name ORDER BY total DESC`,
      [id, bookId]
    );

    const byMonth = await query(`
      WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
      SELECT to_char(date_trunc('month', txn_date), 'YYYY-MM') AS month,
             COALESCE(SUM(amount) FILTER (WHERE direction = 'expense'), 0) AS expense,
             COALESCE(SUM(amount) FILTER (WHERE direction = 'income'), 0)  AS income
      FROM eff_tag
      WHERE kind = 'tag' AND ref_id = $1 AND book_id = $2
      GROUP BY 1 ORDER BY 1`,
      [id, bookId]
    );

    // The transaction LIST is paginated (the aggregates above already cover the full
    // tagged set), so a long-lived tag with thousands of charges doesn't ship and
    // render them all at once. `transactions_total` lets the client page through.
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    // One row per tagged transaction, with the amount attributed to this tag
    // (sum of its tagged lines) so the list reconciles with the totals.
    const transactions = await query(`
      WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
      SELECT eff_tag.id AS txn_id, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
             t.merchant, t.direction, a.name AS account_name,
             SUM(eff_tag.amount) AS amount,
             string_agg(DISTINCT c.name, ', ') AS category_name
      FROM eff_tag
      JOIN transactions t ON t.id = eff_tag.id
      LEFT JOIN accounts a ON a.id = eff_tag.account_id
      LEFT JOIN categories c ON c.id = eff_tag.category_id
      WHERE eff_tag.kind = 'tag' AND eff_tag.ref_id = $1 AND eff_tag.book_id = $2
      GROUP BY eff_tag.id, t.txn_date, t.merchant, t.direction, a.name
      ORDER BY t.txn_date DESC NULLS LAST, eff_tag.id DESC
      LIMIT $3 OFFSET $4`,
      [id, bookId, limit, offset]
    );
    const cnt = await query<{ n: number }>(`
      WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
      SELECT COUNT(DISTINCT eff_tag.id)::int AS n
      FROM eff_tag WHERE kind = 'tag' AND ref_id = $1 AND book_id = $2`,
      [id, bookId]
    );
    const transactions_total = Number(cnt[0]?.n ?? 0);

    res.json({ tag, totals, byCategory, byMonth, transactions, transactions_total });
  })
);
