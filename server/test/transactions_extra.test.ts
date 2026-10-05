import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Seed a book with a spread of transactions to exercise the list filters.
async function seed() {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const acct2 = (await client.post('/api/accounts', { name: 'Savings', type: 'savings' })).body.id;
  const food = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;
  const salary = (await client.post('/api/categories', { name: 'Salary', kind: 'income' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body.id;
  return { client, acct, acct2, food, salary, veh };
}

test('list: date/category/account/text/channel/amount filters + pagination', async () => {
  const { client, acct, acct2, food, salary, veh } = await seed();

  await client.post('/api/transactions', { amount: 40, account_id: acct, category_id: food, direction: 'expense', txn_date: '2026-06-01', posted_date: '2026-06-01', merchant: 'Sonic', channel: 'in_store' });
  await client.post('/api/transactions', { amount: 1000, account_id: acct, category_id: salary, direction: 'income', txn_date: '2026-06-05', posted_date: '2026-06-05', merchant: 'Employer', channel: 'online' });
  // A pending (posted_date null) row.
  await client.post('/api/transactions', { amount: 15, account_id: acct, direction: 'expense', txn_date: '2026-06-10', posted_date: null, description: 'coffee run' });
  // A transfer between the two accounts.
  await client.post('/api/transactions', { amount: 200, account_id: acct, transfer_account_id: acct2, direction: 'transfer', txn_date: '2026-06-07', posted_date: '2026-06-07' });
  // A vehicle-tagged expense.
  await client.post('/api/transactions', { amount: 60, account_id: acct, direction: 'expense', txn_date: '2026-06-08', posted_date: '2026-06-08', merchant: 'Shop', tags: [{ kind: 'vehicle', ref_id: veh }] });

  // Unfiltered: pending + posted split.
  const all = (await client.get('/api/transactions')).body;
  assert.equal(all.pendingTotal, 1);
  assert.ok(all.total >= 4);
  // The tagged row carries its resolved tag; the transfer carries a destination name.
  const transferRow = all.posted.find((r: any) => r.direction === 'transfer');
  assert.equal(transferRow.transfer_account_name, 'Savings');

  // Date range.
  const ranged = (await client.get('/api/transactions?from=2026-06-05&to=2026-06-07')).body;
  assert.ok(ranged.posted.every((r: any) => r.txn_date.slice(0, 10) >= '2026-06-05' && r.txn_date.slice(0, 10) <= '2026-06-07'));

  // Category filter.
  const byCat = (await client.get(`/api/transactions?category_id=${food}`)).body;
  assert.equal(byCat.posted.length, 1);
  assert.equal(byCat.posted[0].category_name, 'Food');

  // Uncategorized only (excludes transfers): the pending coffee row.
  const uncat = (await client.get('/api/transactions?uncategorized=1')).body;
  assert.ok([...uncat.pending, ...uncat.posted].every((r: any) => r.category_id == null && r.direction !== 'transfer'));

  // Transfers only.
  const transfers = (await client.get('/api/transactions?transfers=true')).body;
  assert.ok(transfers.posted.every((r: any) => r.direction === 'transfer'));

  // Account filter — transfer visible from destination account too.
  const byDest = (await client.get(`/api/transactions?account_id=${acct2}`)).body;
  assert.ok(byDest.posted.some((r: any) => r.direction === 'transfer'));

  // Vehicle tag filter.
  const byVeh = (await client.get(`/api/transactions?vehicle_id=${veh}`)).body;
  assert.equal([...byVeh.posted, ...byVeh.pending].length, 1);

  // Text search over merchant/description.
  const q = (await client.get('/api/transactions?q=coffee')).body;
  assert.equal([...q.pending, ...q.posted].length, 1);

  // Channel filter.
  const chan = (await client.get('/api/transactions?channel=online')).body;
  assert.ok(chan.posted.every((r: any) => r.channel === 'online'));

  // Amount operators.
  assert.ok((await client.get('/api/transactions?amount_op=gt&amount=100')).body.posted.every((r: any) => Number(r.amount) > 100));
  assert.ok((await client.get('/api/transactions?amount_op=lt&amount=50')).body.posted.every((r: any) => Number(r.amount) < 50));
  assert.equal((await client.get('/api/transactions?amount_op=eq&amount=40')).body.posted.length, 1);
  const between = (await client.get('/api/transactions?amount_op=between&amount=30&amount_max=100')).body;
  assert.ok(between.posted.every((r: any) => Number(r.amount) >= 30 && Number(r.amount) <= 100));

  // Pagination controls.
  const limited = (await client.get('/api/transactions?limit=1&postedOffset=0')).body;
  assert.equal(limited.posted.length, 1);
});

test('merchants endpoint returns distinct names most-used first', async () => {
  const { client, acct } = await seed();
  await client.post('/api/transactions', { amount: 5, account_id: acct, direction: 'expense', txn_date: '2026-06-01', merchant: 'Costco' });
  await client.post('/api/transactions', { amount: 6, account_id: acct, direction: 'expense', txn_date: '2026-06-02', merchant: 'Costco' });
  await client.post('/api/transactions', { amount: 7, account_id: acct, direction: 'expense', txn_date: '2026-06-03', merchant: 'Target' });
  const merchants = (await client.get('/api/transactions/merchants')).body as string[];
  assert.equal(merchants[0], 'Costco', 'most-used merchant first');
  assert.ok(merchants.includes('Target'));
});

test('similar + bulk-update propagate a merchant rename / category', async () => {
  const { client, acct, food } = await seed();
  const t1 = (await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-06-01', merchant: 'Sonic Drive In #1717 Chanute Ks' })).body;
  const t2 = (await client.post('/api/transactions', { amount: 11, account_id: acct, direction: 'expense', txn_date: '2026-06-02', merchant: 'Sonic Drive In #2283 Mo' })).body;

  // Empty merchant + no new name → no matches.
  assert.deepEqual((await client.post('/api/transactions/similar', { merchant: '' })).body, { transactions: [] });

  // Lookalikes of "Sonic".
  const sim = (await client.post('/api/transactions/similar', { merchant: 'Sonic Drive In #1717 Chanute Ks', exclude_id: t1.id, new_merchant: 'Sonic' })).body;
  assert.ok(sim.transactions.some((r: any) => r.id === t2.id));

  // Bulk-update: rename + set category on both.
  const upd = await client.post('/api/transactions/bulk-update', { ids: [t1.id, t2.id], merchant: 'Sonic', category_id: food });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.updated, 2);

  // Empty ids → updated 0.
  assert.equal((await client.post('/api/transactions/bulk-update', { ids: [] })).body.updated, 0);
  // Only ids, no fields → updated 0.
  assert.equal((await client.post('/api/transactions/bulk-update', { ids: [t1.id] })).body.updated, 0);
  // A cross-book / missing category → 400.
  assert.equal((await client.post('/api/transactions/bulk-update', { ids: [t1.id], category_id: 999999 })).status, 400);
  // Clearing the category (null) is allowed.
  assert.equal((await client.post('/api/transactions/bulk-update', { ids: [t1.id], category_id: null })).body.updated, 1);
});

test('update: edit fields, convert to transfer, splits→tags, and 404', async () => {
  const { client, acct, acct2, food } = await seed();
  const txn = (await client.post('/api/transactions', { amount: 30, account_id: acct, category_id: food, direction: 'expense', txn_date: '2026-06-01', merchant: 'X' })).body;

  // Plain edit.
  const edit = await client.put(`/api/transactions/${txn.id}`, { amount: 45, merchant: 'Y', account_id: acct, category_id: food, direction: 'expense', txn_date: '2026-06-02' });
  assert.equal(edit.status, 200);
  assert.equal(Number(edit.body.amount), 45);
  assert.equal(edit.body.merchant, 'Y');

  // Convert to a transfer — gets a transfer_group_id.
  const toTransfer = await client.put(`/api/transactions/${txn.id}`, { amount: 45, account_id: acct, transfer_account_id: acct2, direction: 'transfer' });
  assert.equal(toTransfer.status, 200);
  assert.match(toTransfer.body.transfer_group_id, /^tg-/);

  // Add splits via update.
  const withSplits = await client.put(`/api/transactions/${txn.id}`, { amount: 50, account_id: acct, direction: 'expense', splits: [{ amount: 20, category_id: food }, { amount: 30, category_id: food }] });
  assert.equal(withSplits.status, 200);
  const listed = (await client.get(`/api/transactions?account_id=${acct}`)).body;
  const row = [...listed.posted, ...listed.pending].find((r: any) => r.id === txn.id);
  assert.equal(row.splits.length, 2);
  assert.equal(row.has_splits, true);

  // 404 updating a missing transaction.
  assert.equal((await client.put('/api/transactions/999999', { amount: 5 })).status, 404);
  // Invalid amount on PUT → 400.
  assert.equal((await client.put(`/api/transactions/${txn.id}`, { amount: 1.005 })).status, 400);
});

test('category change endpoint, post/unpost, and delete', async () => {
  const { client, acct, food } = await seed();
  const txn = (await client.post('/api/transactions', { amount: 30, account_id: acct, direction: 'expense', txn_date: '2026-06-01' })).body;

  // Lightweight category set.
  const catChange = await client.post(`/api/transactions/${txn.id}/category`, { category_id: food });
  assert.equal(catChange.status, 200);
  assert.equal(catChange.body.category_id, food);
  // Clearing it (null) works.
  assert.equal((await client.post(`/api/transactions/${txn.id}/category`, { category_id: null })).body.category_id, null);
  // 404 for a missing transaction.
  assert.equal((await client.post('/api/transactions/999999/category', { category_id: food })).status, 404);

  // Post a pending transaction.
  const pending = (await client.post('/api/transactions', { amount: 8, account_id: acct, direction: 'expense', txn_date: '2026-06-02', posted_date: null })).body;
  const posted = await client.post(`/api/transactions/${pending.id}/post`, { posted_date: '2026-06-03' });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.posted_date.slice(0, 10), '2026-06-03');
  // Back to pending.
  const unposted = await client.post(`/api/transactions/${pending.id}/post`, { posted: false });
  assert.equal(unposted.body.posted_date, null);
  // Bad posted_date → 400.
  assert.equal((await client.post(`/api/transactions/${pending.id}/post`, { posted_date: 'nope' })).status, 400);
  // 404 posting a missing transaction.
  assert.equal((await client.post('/api/transactions/999999/post', {})).status, 404);

  // Delete.
  assert.equal((await client.del(`/api/transactions/${txn.id}`)).status, 204);
});

test('transfer suggestions: detect, ignore, and confirm two posted rows into a transfer', async () => {
  const { client, acct, acct2 } = await seed();
  // Two opposite-direction, equal-amount, different-account posted rows within a few days.
  const out = (await client.post('/api/transactions', { amount: 300, account_id: acct, direction: 'expense', txn_date: '2026-06-10', posted_date: '2026-06-10', merchant: 'Transfer out' })).body;
  const inn = (await client.post('/api/transactions', { amount: 300, account_id: acct2, direction: 'income', txn_date: '2026-06-11', posted_date: '2026-06-11', merchant: 'Transfer in' })).body;

  const suggestions = (await client.get('/api/transactions/transfer-suggestions')).body as any[];
  assert.ok(suggestions.length >= 1, 'a matching pair is suggested');
  const pair = suggestions.find((s: any) => s.out.id === out.id && s.in.id === inn.id);
  assert.ok(pair, 'the seeded pair is detected');

  // Confirm requires two different ids.
  assert.equal((await client.post('/api/transactions/transfer-suggestions/confirm', { out_id: out.id, in_id: out.id })).status, 400);

  // Confirm replaces the two rows with one transfer.
  const confirmed = await client.post('/api/transactions/transfer-suggestions/confirm', { out_id: out.id, in_id: inn.id });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.direction, 'transfer');
  assert.equal(Number(confirmed.body.amount), 300);
  // The originals are gone.
  const remaining = (await client.get('/api/transactions')).body;
  const ids = [...remaining.posted, ...remaining.pending].map((r: any) => r.id);
  assert.ok(!ids.includes(out.id) && !ids.includes(inn.id));

  // Ignore a (new) pair so it's no longer suggested.
  const o2 = (await client.post('/api/transactions', { amount: 75, account_id: acct, direction: 'expense', txn_date: '2026-06-12', posted_date: '2026-06-12' })).body;
  const i2 = (await client.post('/api/transactions', { amount: 75, account_id: acct2, direction: 'income', txn_date: '2026-06-12', posted_date: '2026-06-12' })).body;
  assert.equal((await client.post('/api/transactions/transfer-suggestions/ignore', { out_id: o2.id, in_id: i2.id })).status, 200);
  const afterIgnore = (await client.get('/api/transactions/transfer-suggestions')).body as any[];
  assert.ok(!afterIgnore.some((s: any) => (s.out.id === o2.id && s.in.id === i2.id)));
  // Ignore also needs two different ids.
  assert.equal((await client.post('/api/transactions/transfer-suggestions/ignore', { out_id: o2.id, in_id: o2.id })).status, 400);
});

test('receipt: upsert header + items, fetch, and stream image', async () => {
  const { client, acct } = await seed();
  const txn = (await client.post('/api/transactions', { amount: 25, account_id: acct, direction: 'expense', txn_date: '2026-06-01', merchant: 'Grocer' })).body;

  // No receipt yet → null.
  assert.equal((await client.get(`/api/transactions/${txn.id}/receipt`)).body, null);

  // Upsert a receipt with items and a tiny image.
  const put = await client.put(`/api/transactions/${txn.id}/receipt`, {
    merchant: 'Grocer', purchased_at: '2026-06-01', subtotal: 20, tax: 5, total: 25,
    image: 'aGVsbG8=', image_mime: 'image/png', original_name: 'r.png',
    items: [
      { name: 'Milk', brand: 'GV', category: 'Dairy & Eggs', quantity: 2, unit_price: 3, total_price: 6, size: 32, unit: 'oz' },
      { name: '', quantity: 1 }, // blank name is skipped
    ],
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.items.length, 1, 'blank-name item dropped');
  assert.equal(put.body.items[0].category, 'Dairy & Eggs');

  // Fetch the receipt.
  const got = (await client.get(`/api/transactions/${txn.id}/receipt`)).body;
  assert.equal(Number(got.total), 25);
  assert.equal(got.has_image, true);

  // Stream the image with hardened headers.
  const img = await fetch(`${base}/api/transactions/${txn.id}/receipt/image`, { headers: { cookie: client.cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');

  // Re-upsert without an image keeps the stored one (COALESCE).
  const put2 = await client.put(`/api/transactions/${txn.id}/receipt`, { merchant: 'Grocer', total: 25, items: [] });
  assert.equal(put2.status, 200);
  assert.equal((await client.get(`/api/transactions/${txn.id}/receipt`)).body.has_image, true);

  // Bad money on receipt → 400.
  assert.equal((await client.put(`/api/transactions/${txn.id}/receipt`, { total: 1.005 })).status, 400);
  // 404 for a receipt on a missing transaction.
  assert.equal((await client.get('/api/transactions/999999/receipt')).status, 404);
  assert.equal((await client.get('/api/transactions/999999/receipt/image')).status, 404);
});

test('receipt image 404 when the receipt has no stored file', async () => {
  const { client, acct } = await seed();
  const txn = (await client.post('/api/transactions', { amount: 5, account_id: acct, direction: 'expense', txn_date: '2026-06-01' })).body;
  // Receipt header only, no image.
  await client.put(`/api/transactions/${txn.id}/receipt`, { merchant: 'X', items: [] });
  assert.equal((await client.get(`/api/transactions/${txn.id}/receipt/image`)).status, 404);
});

test('AI endpoints validate input before invoking the model', async () => {
  const { client } = await seed();
  // enrich-items with no items → empty list (no AI call).
  assert.deepEqual((await client.post('/api/transactions/enrich-items', { items: [] })).body, { items: [] });
  // parse-receipt with no image → 400.
  assert.equal((await client.post('/api/transactions/parse-receipt', {})).status, 400);

  // With input, the AI is invoked — assert only that it got past validation.
  const enrich = await client.post('/api/transactions/enrich-items', { items: [{ name: 'Milk 32 oz' }] });
  assert.ok([200, 500, 502, 503].includes(enrich.status), `enrich status ${enrich.status}`);
});

test('GET /transactions sorts by transaction date (default) or posted date, either direction', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const mk = (merchant: string, txn_date: string, posted_date: string | null) =>
    client.post('/api/transactions', { amount: 1, account_id: acct, direction: 'expense', merchant, txn_date, posted_date });
  await mk('A', '2026-09-01', '2026-09-10'); // oldest purchase, latest posting
  await mk('B', '2026-09-05', '2026-09-06');
  await mk('C', '2026-09-03', '2026-09-04');
  await mk('P1', '2026-09-02', null);
  await mk('P2', '2026-09-04', null);
  const order = async (qs = '') => {
    const r = (await client.get(`/api/transactions?limit=50${qs}`)).body;
    return { posted: r.posted.map((t: any) => t.merchant).join(''), pending: r.pending.map((t: any) => t.merchant).join(',') };
  };
  assert.deepEqual(await order(), { posted: 'BCA', pending: 'P2,P1' }, 'default: transaction date, newest first');
  assert.deepEqual(await order('&sort=txn_date&dir=asc'), { posted: 'ACB', pending: 'P1,P2' });
  assert.deepEqual(await order('&sort=posted_date'), { posted: 'ABC', pending: 'P2,P1' }, 'pending stays by transaction date');
  assert.deepEqual(await order('&sort=posted_date&dir=asc'), { posted: 'CBA', pending: 'P1,P2' });
  // Anything else falls back to the default (no SQL from the query string).
  assert.deepEqual(await order('&sort=amount;drop&dir=sideways'), { posted: 'BCA', pending: 'P2,P1' });
});
