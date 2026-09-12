import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hh } from '../tenant.js';

export const categories = Router();

// Flat list of every category with its parent and whether it has children.
// parent_id NULL => high-level group; otherwise => budget item under a group.
// Leaves (has_children = false) are what transactions and budgets attach to.
categories.get(
  '/',
  ah(async (req, res) => {
    res.json(
      await query(`
        SELECT c.*,
               p.name AS parent_name,
               EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = c.id) AS has_children
        FROM categories c
        LEFT JOIN categories p ON p.id = c.parent_id
        WHERE c.book_id = $1
        ORDER BY (c.parent_id IS NOT NULL),
                 COALESCE(p.sort_order, c.sort_order), lower(COALESCE(p.name, c.name)),
                 c.sort_order, lower(c.name)
      `, [hh(req)])
    );
  })
);

// Bulk reorder: set sort_order to the given order for a set of sibling categories.
// When parent_id is provided, the ids become that group's items (parent + kind
// inherited), which also lets a drag move an item into the group at a position.
categories.post(
  '/reorder',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const parentId = req.body?.parent_id ?? null;
    if (ids.length === 0) return res.json({ ok: true });

    let kind: string | null = null;
    if (parentId != null) {
      const parent = await one<{ kind: string; parent_id: number | null }>(
        `SELECT kind, parent_id FROM categories WHERE id = $1 AND book_id = $2`,
        [parentId, bookId]
      );
      if (!parent) throw new HttpError(400, 'Parent category not found.');
      if (parent.parent_id != null) throw new HttpError(400, 'Categories can only be nested one level deep.');
      kind = parent.kind;
    }

    try {
      await withTransaction(async (client) => {
        for (let i = 0; i < ids.length; i++) {
          if (parentId != null) {
            await client.query(
              `UPDATE categories SET parent_id = $1, kind = $2, sort_order = $3 WHERE id = $4 AND book_id = $5`,
              [parentId, kind, i, ids[i], bookId]
            );
          } else {
            // Top-level groups: only reorder, never touch parent/kind.
            await client.query(
              `UPDATE categories SET sort_order = $1 WHERE id = $2 AND parent_id IS NULL AND book_id = $3`,
              [i, ids[i], bookId]
            );
          }
        }
      });
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'A category with that name already exists in the target group.');
      throw e;
    }
    res.json({ ok: true });
  })
);

categories.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const bookId = hh(req);
    const { name, parent_id = null } = req.body;
    let { kind = 'expense' } = req.body;

    if (parent_id != null) {
      const parent = await one<{ id: number; kind: string; parent_id: number | null }>(
        `SELECT id, kind, parent_id FROM categories WHERE id = $1 AND book_id = $2`,
        [parent_id, bookId]
      );
      if (!parent) throw new HttpError(400, 'Parent category not found.');
      if (parent.parent_id != null) throw new HttpError(400, 'Categories can only be nested one level deep.');
      kind = parent.kind; // an item always matches its group's kind
    }

    // Append new categories at the end of their siblings with a unique sort_order
    // (groups order within their kind, excluding the auto-managed ones; items
    // order within their parent), so a newly added category stays put.
    const next = await one<{ n: number }>(
      parent_id != null
        ? `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories WHERE parent_id = $1 AND book_id = $2`
        : `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories WHERE parent_id IS NULL AND kind = $1 AND NOT managed AND book_id = $2`,
      [parent_id != null ? parent_id : kind, bookId]
    );
    const sortOrder = next?.n ?? 0;

    try {
      const row = await one(
        `INSERT INTO categories (name, kind, parent_id, sort_order, book_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, kind, parent_id, sortOrder, bookId]
      );
      res.status(201).json(row);
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'A category with that name already exists here.');
      throw e;
    }
  })
);

categories.put(
  '/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const bookId = hh(req);
    const { name, kind, parent_id } = req.body;
    const mng = await one<{ managed: boolean }>(`SELECT managed FROM categories WHERE id = $1 AND book_id = $2`, [id, bookId]);
    if (!mng) throw new HttpError(404, 'Category not found');
    if (mng.managed) throw new HttpError(400, 'This category is managed automatically — edit it on its source page.');
    if (parent_id != null && Number(parent_id) === id) {
      throw new HttpError(400, 'A category cannot be its own parent.');
    }

    // When given a parent, validate depth/cycles and inherit the parent's kind.
    let finalKind = kind ?? null;
    if (parent_id != null) {
      const parent = await one<{ kind: string; parent_id: number | null }>(
        `SELECT kind, parent_id FROM categories WHERE id = $1 AND book_id = $2`,
        [parent_id, bookId]
      );
      if (!parent) throw new HttpError(400, 'Parent category not found.');
      if (parent.parent_id != null) throw new HttpError(400, 'Categories can only be nested one level deep.');
      const hasKids = await one(`SELECT 1 FROM categories WHERE parent_id = $1 AND book_id = $2 LIMIT 1`, [id, bookId]);
      if (hasKids) throw new HttpError(400, 'Move this group’s items out before making it an item.');
      finalKind = parent.kind;
    }

    try {
      const row = await one<{ id: number; parent_id: number | null }>(
        `UPDATE categories SET
           name = COALESCE($2, name),
           kind = COALESCE($3, kind),
           parent_id = $4
         WHERE id = $1 AND book_id = $5 RETURNING *`,
        [id, name ?? null, finalKind, parent_id ?? null, bookId]
      );
      if (!row) throw new HttpError(404, 'Category not found');
      // Changing a group's kind cascades to its items so they stay consistent.
      if (row.parent_id == null && kind) {
        await query(`UPDATE categories SET kind = $2 WHERE parent_id = $1 AND book_id = $3`, [id, kind, bookId]);
      }
      res.json(row);
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'A category with that name already exists here.');
      throw e;
    }
  })
);

// The category id plus its item children (transactions/budgets attach to leaves).
async function categoryFamily(id: number, bookId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(`SELECT id FROM categories WHERE (id = $1 OR parent_id = $1) AND book_id = $2`, [id, bookId]);
  return rows.map((r) => r.id);
}

// Delete becomes archive when the category (or an item) is in historical use, so
// transaction/budget reports keep a resolvable category name. Unused categories
// are still hard-deleted.
categories.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    const id = Number(req.params.id);
    const mng = await one<{ managed: boolean }>(`SELECT managed FROM categories WHERE id = $1 AND book_id = $2`, [id, bookId]);
    if (!mng) throw new HttpError(404, 'Category not found');
    if (mng.managed) throw new HttpError(400, 'This category is managed automatically — remove it on its source page.');
    const ids = await categoryFamily(id, bookId);
    // Check + (archive|delete) atomically so a concurrent insert that references
    // the category can't slip between the "is it used?" probe and the delete. The
    // probe must cover EVERY table whose category_id is ON DELETE SET NULL —
    // otherwise deleting a category used only by e.g. a subscription silently
    // nulls that link instead of archiving.
    const result = await withTransaction(async (client) => {
      const used = (await client.query(
        `SELECT 1 FROM transactions        WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM transactions        WHERE interest_category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM transaction_splits  WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM budget_lines        WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM budget_period_lines WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM subscriptions       WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM goals               WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM utility_invoices    WHERE category_id = ANY($1) AND book_id = $2
         UNION ALL SELECT 1 FROM staged_transactions WHERE category_id = ANY($1) AND book_id = $2
         LIMIT 1`,
        [ids, bookId]
      )).rows[0];
      if (used) {
        await client.query(`UPDATE categories SET archived_at = now() WHERE id = ANY($1) AND book_id = $2 AND archived_at IS NULL`, [ids, bookId]);
        return { archived: true };
      }
      await client.query(`DELETE FROM categories WHERE id = $1 AND book_id = $2`, [id, bookId]);
      return { archived: false };
    });
    if (result.archived) return res.status(200).json({ archived: true });
    res.status(204).end();
  })
);

// Archive / unarchive a category (and its items). Archived categories stay
// reportable but are meant to be hidden from pickers in the UI.
categories.post(
  '/:id/archive',
  ah(async (req, res) => {
    const bookId = hh(req);
    const id = Number(req.params.id);
    const mng = await one<{ managed: boolean }>(`SELECT managed FROM categories WHERE id = $1 AND book_id = $2`, [id, bookId]);
    if (!mng) throw new HttpError(404, 'Category not found');
    if (mng.managed) throw new HttpError(400, 'This category is managed automatically.');
    const archived = req.body?.archived !== false; // default true
    const ids = await categoryFamily(id, bookId);
    await query(`UPDATE categories SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = ANY($1) AND book_id = $2`, [ids, bookId, archived]);
    res.json({ archived });
  })
);
