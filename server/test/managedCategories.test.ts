import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { syncManagedCategories, syncManagedCategoriesSafe, syncAllManagedCategoriesSafe } from '../src/managedCategories.js';

// managedCategories reconciles a book's "Utilities" managed category group with
// its utility_accounts rows. It talks only to Postgres (the app pool) — no
// network. We exercise it directly against the test DB.

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Read the managed Utilities group + its child items for a book (RLS-scoped).
async function readManaged(bookId: number) {
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const grp = (await db.query(
      `SELECT id, name, sort_order FROM categories WHERE managed AND parent_id IS NULL AND source_kind = 'utilities' AND book_id = $1`,
      [bookId]
    )).rows[0];
    if (!grp) return { group: null as any, items: [] as any[] };
    const items = (await db.query(
      `SELECT id, source_id, name, sort_order FROM categories
       WHERE managed AND parent_id = $1 AND source_kind = 'utility' AND book_id = $2 ORDER BY sort_order`,
      [grp.id, bookId]
    )).rows;
    return { group: grp, items };
  } finally { await db.end(); }
}

test('creating a utility account (via API) syncs a managed Utilities category + item', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/utilities/accounts', { name: 'Zed Electric', utility_type: 'electricity' })).body;

  // The route fires syncManagedCategoriesSafe; call sync directly too to be certain
  // it's settled (idempotent).
  await syncManagedCategories(bookId);

  const { group, items } = await readManaged(bookId);
  assert.ok(group, 'a managed Utilities group exists');
  assert.equal(group.name, 'Utilities');
  assert.equal(Number(group.sort_order), 1000);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Zed Electric');
  assert.equal(Number(items[0].source_id), acct.id);
});

test('renaming the source account renames the managed item; new accounts are appended and sorted', async () => {
  const { client, bookId } = await registerUser(base);
  const a = (await client.post('/api/utilities/accounts', { name: 'Apple Water' })).body;
  const z = (await client.post('/api/utilities/accounts', { name: 'Zebra Gas' })).body;
  await syncManagedCategories(bookId);

  // Rename Apple Water -> Yak Water directly in the source table, then re-sync.
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await db.query(`UPDATE utility_accounts SET name = 'Yak Water' WHERE id = $1 AND book_id = $2`, [a.id, bookId]);
  } finally { await db.end(); }
  await syncManagedCategories(bookId);

  const { items } = await readManaged(bookId);
  assert.equal(items.length, 2);
  const byId = new Map(items.map((i: any) => [Number(i.source_id), i]));
  assert.equal(byId.get(a.id).name, 'Yak Water');
  assert.equal(byId.get(z.id).name, 'Zebra Gas');
  // rowsSql orders by lower(name): "Yak" < "Zebra", so sort_order 0 then 1.
  assert.equal(Number(byId.get(a.id).sort_order), 0);
  assert.equal(Number(byId.get(z.id).sort_order), 1);
});

test('deleting the source account removes the managed item (orphan cleanup)', async () => {
  const { client, bookId } = await registerUser(base);
  const keep = (await client.post('/api/utilities/accounts', { name: 'Keeper Co' })).body;
  const gone = (await client.post('/api/utilities/accounts', { name: 'Doomed Co' })).body;
  await syncManagedCategories(bookId);
  assert.equal((await readManaged(bookId)).items.length, 2);

  // Hard-delete the source row, then sync — the managed item must be pruned.
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await db.query(`DELETE FROM utility_accounts WHERE id = $1 AND book_id = $2`, [gone.id, bookId]);
  } finally { await db.end(); }
  await syncManagedCategories(bookId);

  const { items } = await readManaged(bookId);
  assert.equal(items.length, 1);
  assert.equal(Number(items[0].source_id), keep.id);
});

test('orphan cleanup also drops budget lines that reference the managed item', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/utilities/accounts', { name: 'Budgeted Utility' })).body;
  await syncManagedCategories(bookId);
  const catId = (await readManaged(bookId)).items[0].id;

  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    // A budget line on the managed category would block a naive DELETE; sync must
    // remove it first.
    await db.query(
      `INSERT INTO budgets (name, period, book_id) VALUES ('B','monthly',$1)
       ON CONFLICT DO NOTHING`, [bookId]
    ).catch(() => {});
    const budget = (await db.query(`SELECT id FROM budgets WHERE book_id = $1 LIMIT 1`, [bookId])).rows[0];
    await db.query(
      `INSERT INTO budget_lines (budget_id, category_id, amount, book_id) VALUES ($1,$2,$3,$4)`,
      [budget.id, catId, 100, bookId]
    );
    // Delete the source account.
    await db.query(`DELETE FROM utility_accounts WHERE id = $1 AND book_id = $2`, [acct.id, bookId]);
  } finally { await db.end(); }

  await syncManagedCategories(bookId);
  const { items } = await readManaged(bookId);
  assert.equal(items.length, 0, 'managed item (and its budget line) removed');
});

test('sync repairs a drifted group name/sort_order back to the canonical values', async () => {
  const { client, bookId } = await registerUser(base);
  await client.post('/api/utilities/accounts', { name: 'Repair Co' });
  await syncManagedCategories(bookId);
  const before = await readManaged(bookId);

  // Corrupt the managed group's name + sort_order, then re-sync: it must be fixed.
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await db.query(`UPDATE categories SET name = 'WRONG', sort_order = 5 WHERE id = $1 AND book_id = $2`, [before.group.id, bookId]);
  } finally { await db.end(); }
  await syncManagedCategories(bookId);

  const after = await readManaged(bookId);
  assert.equal(after.group.id, before.group.id);
  assert.equal(after.group.name, 'Utilities');
  assert.equal(Number(after.group.sort_order), 1000);
});

test('sync is idempotent — running twice is a no-op', async () => {
  const { client, bookId } = await registerUser(base);
  await client.post('/api/utilities/accounts', { name: 'Idempotent Co' });
  await syncManagedCategories(bookId);
  const first = await readManaged(bookId);
  await syncManagedCategories(bookId);
  const second = await readManaged(bookId);
  assert.deepEqual(second.items.map((i: any) => Number(i.source_id)), first.items.map((i: any) => Number(i.source_id)));
  assert.equal(second.group.id, first.group.id);
});

test('syncManagedCategoriesSafe swallows errors and never throws', async () => {
  // A non-existent book id — the sync sets the GUC and finds no rows; must not throw.
  await assert.doesNotReject(async () => {
    syncManagedCategoriesSafe(999999999);
    // Give the fire-and-forget promise a tick to settle.
    await new Promise((r) => setTimeout(r, 50));
  });
});

test('syncAllManagedCategoriesSafe reconciles every book without throwing', async () => {
  const { client, bookId } = await registerUser(base);
  await client.post('/api/utilities/accounts', { name: 'Global Sync Co' });
  await assert.doesNotReject(syncAllManagedCategoriesSafe());
  // Our book got its managed item as part of the all-books pass.
  const { items } = await readManaged(bookId);
  assert.ok(items.some((i: any) => i.name === 'Global Sync Co'));
});
