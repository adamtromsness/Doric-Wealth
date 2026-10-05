import { pool, BOOK_LOCK } from './db.js';

// Each managed group mirrors rows from a source table into category items. The
// rowsSql is book-scoped ($1 = book id) so each book gets its own
// managed Utilities/Subscriptions categories.
// Subscriptions used to be a managed category group too, but are now tracked as
// tags (kind='subscription') instead — see migration 069. Utilities remain a
// managed category because the invoice auto-payment logic is wired to it.
const GROUPS = [
  {
    sourceKind: 'utilities', itemKind: 'utility', name: 'Utilities', sortOrder: 1000,
    rowsSql: `SELECT id, name FROM utility_accounts WHERE book_id = $1 ORDER BY lower(name)`,
  },
];

// Reconcile the managed category groups/items with their source entities for ONE
// book. Real category rows are created/renamed/removed so they stay
// selectable for that book's transactions and budgets. Idempotent.
export async function syncManagedCategories(bookId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // This runs outside a request, so set the RLS book GUC for this transaction.
    await client.query(`SELECT set_config('app.book_id', $1, true), pg_advisory_xact_lock_shared(${BOOK_LOCK}, $2)`, [String(bookId), bookId]);
    for (const g of GROUPS) {
      // Ensure the group exists for this book (skip if a manual category owns the name).
      let grp = (await client.query(
        `SELECT id, name, sort_order FROM categories WHERE managed AND parent_id IS NULL AND source_kind = $1 AND book_id = $2`,
        [g.sourceKind, bookId]
      )).rows[0];
      if (!grp) {
        await client.query(
          `INSERT INTO categories (name, kind, parent_id, sort_order, managed, source_kind, book_id)
           VALUES ($1,'expense',NULL,$2,true,$3,$4) ON CONFLICT DO NOTHING`,
          [g.name, g.sortOrder, g.sourceKind, bookId]
        );
        grp = (await client.query(
          `SELECT id, name, sort_order FROM categories WHERE managed AND parent_id IS NULL AND source_kind = $1 AND book_id = $2`,
          [g.sourceKind, bookId]
        )).rows[0];
        if (!grp) continue; // name collided with a manual group — leave it alone
      } else if (grp.name !== g.name || grp.sort_order !== g.sortOrder) {
        await client.query(`UPDATE categories SET name = $2, sort_order = $3 WHERE id = $1 AND book_id = $4`, [grp.id, g.name, g.sortOrder, bookId]);
      }
      const groupId: number = grp.id;

      const entities = (await client.query(g.rowsSql, [bookId])).rows as { id: number; name: string }[];
      const existing = (await client.query(
        `SELECT id, source_id, name, sort_order FROM categories WHERE managed AND parent_id = $1 AND source_kind = $2 AND book_id = $3`,
        [groupId, g.itemKind, bookId]
      )).rows as { id: number; source_id: number; name: string; sort_order: number }[];
      const bySource = new Map(existing.map((r) => [r.source_id, r]));

      let order = 0;
      for (const e of entities) {
        const cur = bySource.get(e.id);
        if (cur) {
          if (cur.name !== e.name || cur.sort_order !== order) {
            await client.query(`UPDATE categories SET name = $2, sort_order = $3 WHERE id = $1 AND book_id = $4`, [cur.id, e.name, order, bookId]);
          }
        } else {
          await client.query(
            `INSERT INTO categories (name, kind, parent_id, sort_order, managed, source_kind, source_id, book_id)
             VALUES ($1,'expense',$2,$3,true,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [e.name, groupId, order, g.itemKind, e.id, bookId]
          );
        }
        order++;
      }

      // Remove items whose source entity no longer exists (drop any budget lines
      // on them first, since budget_lines blocks category deletion).
      const liveIds = new Set(entities.map((e) => e.id));
      const orphans = existing.filter((r) => !liveIds.has(r.source_id)).map((r) => r.id);
      if (orphans.length) {
        await client.query(`DELETE FROM budget_lines WHERE category_id = ANY($1) AND book_id = $2`, [orphans, bookId]);
        await client.query(`DELETE FROM categories WHERE id = ANY($1) AND book_id = $2`, [orphans, bookId]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Fire-and-forget for one book: never let a sync failure break the request.
export function syncManagedCategoriesSafe(bookId: number): void {
  syncManagedCategories(bookId).catch((e) => console.error('managed category sync failed:', e));
}

// Reconcile every book (used on boot).
export async function syncAllManagedCategoriesSafe(): Promise<void> {
  try {
    const hs = await pool.query(`SELECT id FROM books ORDER BY id`);
    for (const h of hs.rows) await syncManagedCategories(h.id);
  } catch (e) {
    console.error('managed category sync (all books) failed:', e);
  }
}
