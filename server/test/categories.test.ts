import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('CRUD: create group, nested item, list shape, update, delete unused', async () => {
  const { client } = await registerUser(base);

  // Create a top-level group (parent_id null).
  const group = await client.post('/api/categories', { name: 'Housing', kind: 'expense' });
  assert.equal(group.status, 201);
  assert.equal(group.body.parent_id, null);
  assert.equal(group.body.kind, 'expense');

  // A nested item inherits the parent's kind even if a different kind is passed.
  const item = await client.post('/api/categories', { name: 'Rent', kind: 'income', parent_id: group.body.id });
  assert.equal(item.status, 201);
  assert.equal(item.body.parent_id, group.body.id);
  assert.equal(item.body.kind, 'expense', 'item inherits the group kind');

  // List: group appears with has_children true; item has parent_name.
  const list = (await client.get('/api/categories')).body as any[];
  const g = list.find((c) => c.id === group.body.id);
  const it = list.find((c) => c.id === item.body.id);
  assert.equal(g.has_children, true);
  assert.equal(it.has_children, false);
  assert.equal(it.parent_name, 'Housing');

  // Update the item's name.
  const upd = await client.put(`/api/categories/${item.body.id}`, { name: 'Monthly Rent' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Monthly Rent');

  // Delete the (unused) item → hard delete (204).
  assert.equal((await client.del(`/api/categories/${item.body.id}`)).status, 204);
  // And the now-childless group.
  assert.equal((await client.del(`/api/categories/${group.body.id}`)).status, 204);
  const after2 = (await client.get('/api/categories')).body as any[];
  assert.ok(!after2.some((c) => c.id === group.body.id));
});

test('create: validation and nesting-depth / parent checks', async () => {
  const { client } = await registerUser(base);
  // Missing name → 400.
  assert.equal((await client.post('/api/categories', {})).status, 400);
  // Unknown parent → 400.
  assert.equal((await client.post('/api/categories', { name: 'X', parent_id: 999999 })).status, 400);

  const group = (await client.post('/api/categories', { name: 'G', kind: 'expense' })).body;
  const item = (await client.post('/api/categories', { name: 'I', parent_id: group.id })).body;
  // Nesting under an item (two levels deep) → 400.
  const deep = await client.post('/api/categories', { name: 'Deep', parent_id: item.id });
  assert.equal(deep.status, 400);
  assert.match(deep.body.error, /one level deep/);

  // Duplicate name in the same group → 409.
  const dup = await client.post('/api/categories', { name: 'I', parent_id: group.id });
  assert.equal(dup.status, 409);
});

test('update: managed guard, self-parent, depth, kind cascade, dup', async () => {
  const { client } = await registerUser(base);
  const group = (await client.post('/api/categories', { name: 'Grp', kind: 'expense' })).body;
  const child = (await client.post('/api/categories', { name: 'Child', parent_id: group.id })).body;

  // 404 for a nonexistent category.
  assert.equal((await client.put('/api/categories/999999', { name: 'z' })).status, 404);

  // A category cannot be its own parent.
  const self = await client.put(`/api/categories/${group.id}`, { parent_id: group.id });
  assert.equal(self.status, 400);
  assert.match(self.body.error, /own parent/);

  // Making a group-with-children into an item is refused.
  const other = (await client.post('/api/categories', { name: 'Other', kind: 'expense' })).body;
  const moveGroup = await client.put(`/api/categories/${group.id}`, { parent_id: other.id });
  assert.equal(moveGroup.status, 400);
  assert.match(moveGroup.body.error, /items out/);

  // Changing the group's kind cascades to its item.
  assert.equal((await client.put(`/api/categories/${group.id}`, { kind: 'income' })).status, 200);
  const listed = (await client.get('/api/categories')).body as any[];
  assert.equal(listed.find((c) => c.id === child.id).kind, 'income', 'child kind cascaded');

  // Moving the child under a parent whose parent_id is set → depth error.
  const g2 = (await client.post('/api/categories', { name: 'G2', kind: 'expense' })).body;
  const g2child = (await client.post('/api/categories', { name: 'G2C', parent_id: g2.id })).body;
  const badMove = await client.put(`/api/categories/${child.id}`, { parent_id: g2child.id });
  assert.equal(badMove.status, 400);
  assert.match(badMove.body.error, /one level deep/);

  // Move child under a valid other group → inherits that kind.
  const moved = await client.put(`/api/categories/${child.id}`, { parent_id: g2.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.parent_id, g2.id);
  assert.equal(moved.body.kind, 'expense');

  // Update to a parent id that doesn't exist → 400.
  assert.equal((await client.put(`/api/categories/${child.id}`, { parent_id: 987654 })).status, 400);
});

test('delete: in-use category is archived, not deleted', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body;
  // Use the category on a transaction.
  await client.post('/api/transactions', { amount: 10, account_id: acct, category_id: cat.id, direction: 'expense', txn_date: '2026-06-01' });

  const del = await client.del(`/api/categories/${cat.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.archived, true);

  // The category is still present but archived_at is set.
  const listed = (await client.get('/api/categories')).body as any[];
  const still = listed.find((c) => c.id === cat.id);
  assert.ok(still, 'archived category is still listed');
  assert.ok(still.archived_at != null);

  // 404 deleting a missing category.
  assert.equal((await client.del('/api/categories/999999')).status, 404);
});

test('archive / unarchive endpoint toggles archived_at (incl. children)', async () => {
  const { client } = await registerUser(base);
  const group = (await client.post('/api/categories', { name: 'Grp', kind: 'expense' })).body;
  const child = (await client.post('/api/categories', { name: 'Kid', parent_id: group.id })).body;

  // Archive (default true) archives the family.
  const arch = await client.post(`/api/categories/${group.id}/archive`, {});
  assert.equal(arch.status, 200);
  assert.equal(arch.body.archived, true);
  let listed = (await client.get('/api/categories')).body as any[];
  assert.ok(listed.find((c) => c.id === group.id).archived_at != null);
  assert.ok(listed.find((c) => c.id === child.id).archived_at != null, 'child archived too');

  // Unarchive with archived:false.
  const un = await client.post(`/api/categories/${group.id}/archive`, { archived: false });
  assert.equal(un.body.archived, false);
  listed = (await client.get('/api/categories')).body as any[];
  assert.equal(listed.find((c) => c.id === group.id).archived_at, null);

  // 404 on missing category.
  assert.equal((await client.post('/api/categories/999999/archive', {})).status, 404);
});

test('reorder: top-level groups and moving items into a group', async () => {
  const { client } = await registerUser(base);
  const g1 = (await client.post('/api/categories', { name: 'Alpha', kind: 'expense' })).body;
  const g2 = (await client.post('/api/categories', { name: 'Beta', kind: 'expense' })).body;
  const g3 = (await client.post('/api/categories', { name: 'Gamma', kind: 'expense' })).body;

  // Empty ids → no-op ok:true.
  assert.deepEqual((await client.post('/api/categories/reorder', { ids: [] })).body, { ok: true });

  // Reorder top-level groups (parent_id omitted).
  const r = await client.post('/api/categories/reorder', { ids: [g3.id, g1.id, g2.id] });
  assert.equal(r.status, 200);
  let list = (await client.get('/api/categories')).body as any[];
  const groups = list.filter((c) => c.parent_id == null && ['Alpha', 'Beta', 'Gamma'].includes(c.name));
  assert.equal(groups[0].name, 'Gamma', 'first group is now Gamma');

  // Move g1 and g2 to become items of g3 via reorder with parent_id.
  const into = await client.post('/api/categories/reorder', { ids: [g1.id, g2.id], parent_id: g3.id });
  assert.equal(into.status, 200);
  list = (await client.get('/api/categories')).body as any[];
  assert.equal(list.find((c) => c.id === g1.id).parent_id, g3.id);
  assert.equal(list.find((c) => c.id === g2.id).parent_id, g3.id);
});

test('reorder: parent validation errors', async () => {
  const { client } = await registerUser(base);
  const g = (await client.post('/api/categories', { name: 'G', kind: 'expense' })).body;
  const item = (await client.post('/api/categories', { name: 'It', parent_id: g.id })).body;

  // Unknown parent → 400.
  const badParent = await client.post('/api/categories/reorder', { ids: [g.id], parent_id: 999999 });
  assert.equal(badParent.status, 400);
  assert.match(badParent.body.error, /Parent category not found/);

  // A parent that is itself an item (nested) → 400 depth.
  const nested = await client.post('/api/categories/reorder', { ids: [g.id], parent_id: item.id });
  assert.equal(nested.status, 400);
  assert.match(nested.body.error, /one level deep/);
});

test('reorder: moving into a group with a name collision → 409', async () => {
  const { client } = await registerUser(base);
  const g1 = (await client.post('/api/categories', { name: 'G1', kind: 'expense' })).body;
  const g2 = (await client.post('/api/categories', { name: 'G2', kind: 'expense' })).body;
  // Both groups have an item named "Dup".
  const dupA = (await client.post('/api/categories', { name: 'Dup', parent_id: g1.id })).body;
  await client.post('/api/categories', { name: 'Dup', parent_id: g2.id });
  // Moving g1's "Dup" into g2 collides with g2's existing "Dup".
  const clash = await client.post('/api/categories/reorder', { ids: [dupA.id], parent_id: g2.id });
  assert.equal(clash.status, 409);
});

test('managed categories are guarded from edit / delete / archive', async () => {
  const { client, bookId } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'AutoManaged', kind: 'expense' })).body;
  // Flip the flag directly (managed categories are normally created by the utility
  // sync job, which is fire-and-forget and racy — set it deterministically here).
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`UPDATE categories SET managed = true WHERE id = $1 AND book_id = $2`, [cat.id, bookId]);
  } finally {
    await db.end();
  }

  const upd = await client.put(`/api/categories/${cat.id}`, { name: 'Nope' });
  assert.equal(upd.status, 400);
  assert.match(upd.body.error, /managed automatically/);

  const del = await client.del(`/api/categories/${cat.id}`);
  assert.equal(del.status, 400);
  assert.match(del.body.error, /managed automatically/);

  const arch = await client.post(`/api/categories/${cat.id}/archive`, {});
  assert.equal(arch.status, 400);
  assert.match(arch.body.error, /managed automatically/);
});

test('tenant isolation: another book cannot touch a category', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const cat = (await a.client.post('/api/categories', { name: 'Mine', kind: 'expense' })).body;

  // B's category list does not include A's category.
  assert.ok(!((await b.client.get('/api/categories')).body as any[]).some((c) => c.id === cat.id));
  // B cannot update / delete / archive A's category → 404.
  assert.equal((await b.client.put(`/api/categories/${cat.id}`, { name: 'Hijack' })).status, 404);
  assert.equal((await b.client.del(`/api/categories/${cat.id}`)).status, 404);
  assert.equal((await b.client.post(`/api/categories/${cat.id}/archive`, {})).status, 404);
  // B cannot make A's category its own parent (unknown parent in B's book) → 400.
  const bCat = (await b.client.post('/api/categories', { name: 'BCat', kind: 'expense' })).body;
  assert.equal((await b.client.put(`/api/categories/${bCat.id}`, { parent_id: cat.id })).status, 400);
});
