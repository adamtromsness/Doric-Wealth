import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, dropDatabase, runScript, testDbClient } from './helpers.js';

// The real migrate + seed scripts, run against a brand-new throwaway database, to
// prove a fresh install comes up coherent and fully tenant-stamped.
const SEED_DB = 'finance_test_seed';

test('fresh setup: migrate + seed produce coherent, book-stamped data', async () => {
  const url = await createDatabase(SEED_DB);
  try {
    await runScript('src/migrate.ts', url);
    await runScript('src/seed.ts', url);

    const db = testDbClient(url);
    await db.connect();
    try {
      const books = (await db.query(`SELECT count(*)::int AS n FROM books`)).rows[0].n;
      assert.ok(books >= 1, 'seed created/used a book');

      // Every seeded tenant table must be non-empty and carry a book_id.
      for (const t of ['accounts', 'categories', 'transactions', 'budgets', 'budget_lines',
                       'utility_accounts', 'utility_invoices', 'receipts', 'receipt_items']) {
        const r = (await db.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE book_id IS NULL)::int AS nulls FROM ${t}`
        )).rows[0];
        assert.ok(r.total > 0, `${t} was seeded`);
        assert.equal(r.nulls, 0, `${t} has no NULL book_id`);
      }
    } finally {
      await db.end();
    }
  } finally {
    await dropDatabase(SEED_DB);
  }
});
