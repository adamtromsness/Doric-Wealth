import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ── Create validation + list + summary + reorder ─────────────────────────────
test('create validation: required fields, bad money/enum/date, cross-book refs', async () => {
  const { client } = await registerUser(base);

  // Missing name/amount → 400.
  assert.equal((await client.post('/api/subscriptions', {})).status, 400);
  assert.equal((await client.post('/api/subscriptions', { name: 'X' })).status, 400);

  // Sub-cent amount → 400 (money rejects it).
  assert.equal((await client.post('/api/subscriptions', { name: 'X', amount: 5.001 })).status, 400);
  // Negative amount → 400 (min 0).
  assert.equal((await client.post('/api/subscriptions', { name: 'X', amount: -5 })).status, 400);
  // Bad billing cycle → 400.
  assert.equal((await client.post('/api/subscriptions', { name: 'X', amount: 5, billing_cycle: 'nope' })).status, 400);
  // Bad status → 400.
  assert.equal((await client.post('/api/subscriptions', { name: 'X', amount: 5, status: 'nope' })).status, 400);
  // Bad date → 400.
  assert.equal((await client.post('/api/subscriptions', { name: 'X', amount: 5, next_due_date: 'nope' })).status, 400);

  // Cross-book category ref → 404.
  const other = await registerUser(base);
  const otherCat = (await other.client.post('/api/categories', { name: 'C', kind: 'expense' })).body.id;
  assert.equal((await client.post('/api/subscriptions', { name: 'X', amount: 5, category_id: otherCat })).status, 404);
});

test('list, summary (monthly/yearly totals), reorder', async () => {
  const { client } = await registerUser(base);
  const s1 = (await client.post('/api/subscriptions', { name: 'Monthly', amount: 10, billing_cycle: 'monthly', status: 'active', next_due_date: '2026-09-20' })).body;
  const s2 = (await client.post('/api/subscriptions', { name: 'Yearly', amount: 120, billing_cycle: 'yearly', status: 'active' })).body;
  // monthly_amount derived field.
  assert.equal(s1.monthly_amount, 10);
  assert.equal(s2.monthly_amount, 10); // 120 / 12

  const list = (await client.get('/api/subscriptions')).body;
  assert.ok(list.some((s: any) => s.id === s1.id));
  assert.ok(list.every((s: any) => 'monthly_amount' in s && 'doc_count' in s));

  const summary = (await client.get('/api/subscriptions/summary')).body;
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.monthlyTotal, 20);
  assert.equal(summary.yearlyTotal, 240);
  assert.ok(summary.upcoming.some((u: any) => u.id === s1.id)); // due within 30 days

  // Reorder (and a non-array body is tolerated).
  assert.equal((await client.post('/api/subscriptions/reorder', { ids: [s2.id, s1.id] })).status, 200);
  assert.equal((await client.post('/api/subscriptions/reorder', { ids: 'nope' })).status, 200);
});

// ── PUT edit (price-history on change) + not-found ───────────────────────────
test('update records price history on amount/cycle change; 404 on missing', async () => {
  const { client } = await registerUser(base);
  const sub = (await client.post('/api/subscriptions', { name: 'Plan', amount: 10, billing_cycle: 'monthly', start_date: '2026-01-01' })).body;

  // Seed price history exists from create.
  let hist = (await client.get(`/api/subscriptions/${sub.id}/price-history`)).body;
  assert.equal(hist.length, 1);

  // Edit changing the amount → new price-history row.
  const upd = await client.put(`/api/subscriptions/${sub.id}`, { amount: 12, name: 'Plan+' });
  assert.equal(upd.status, 200);
  assert.equal(Number(upd.body.amount), 12);
  hist = (await client.get(`/api/subscriptions/${sub.id}/price-history`)).body;
  assert.equal(hist.length, 2);

  // Edit that does NOT change price/cycle → no new history row.
  await client.put(`/api/subscriptions/${sub.id}`, { notes: 'just notes' });
  hist = (await client.get(`/api/subscriptions/${sub.id}/price-history`)).body;
  assert.equal(hist.length, 2);

  // Validation still applies on update (bad cycle → 400).
  assert.equal((await client.put(`/api/subscriptions/${sub.id}`, { billing_cycle: 'nope' })).status, 400);

  // 404 on a missing subscription.
  assert.equal((await client.put('/api/subscriptions/999999', { name: 'x' })).status, 404);
  assert.equal((await client.get('/api/subscriptions/999999/price-history')).status, 404);
});

// ── Cancel / pause / reactivate ──────────────────────────────────────────────
test('cancel immediate + scheduled, pause, reactivate; all 404 on missing', async () => {
  const { client } = await registerUser(base);
  const sub = (await client.post('/api/subscriptions', { name: 'S', amount: 5, billing_cycle: 'monthly' })).body;

  // Immediate cancel.
  const c = await client.post(`/api/subscriptions/${sub.id}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'canceled');

  // Reactivate (canceled → active, next_due_date set to date).
  const r = await client.post(`/api/subscriptions/${sub.id}/reactivate`, { date: '2026-10-01' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'active');
  assert.ok(String(r.body.next_due_date).startsWith('2026-10-01'));

  // Pause.
  const p = await client.post(`/api/subscriptions/${sub.id}/pause`, {});
  assert.equal(p.status, 200);
  assert.equal(p.body.status, 'paused');

  // Scheduled cancel (future) leaves it active with an end date.
  const sched = await client.post(`/api/subscriptions/${sub.id}/reactivate`, {});
  assert.equal(sched.status, 200);
  const future = await client.post(`/api/subscriptions/${sub.id}/cancel`, { date: '2099-01-01' });
  assert.equal(future.body.status, 'active');
  assert.ok(String(future.body.end_date).startsWith('2099-01-01'));

  // 404s.
  assert.equal((await client.post('/api/subscriptions/999999/cancel', {})).status, 404);
  assert.equal((await client.post('/api/subscriptions/999999/pause', {})).status, 404);
  assert.equal((await client.post('/api/subscriptions/999999/reactivate', {})).status, 404);
});

// ── Pay: creates a transaction and advances the due date ─────────────────────
test('pay logs a transaction and advances the due date by one cycle; bad date → 400; 404 missing', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  const sub = (await client.post('/api/subscriptions', { name: 'Netflix', amount: 15, billing_cycle: 'monthly', account_id: acct, next_due_date: '2026-06-01' })).body;

  const pay = await client.post(`/api/subscriptions/${sub.id}/pay`, { txn_date: '2026-06-01' });
  assert.equal(pay.status, 201);
  assert.equal(Number(pay.body.transaction.amount), 15);
  assert.ok(String(pay.body.subscription.next_due_date).startsWith('2026-07-01'));

  // Bad txn_date → 400.
  assert.equal((await client.post(`/api/subscriptions/${sub.id}/pay`, { txn_date: 'nope' })).status, 400);

  // 404 on a missing subscription.
  assert.equal((await client.post('/api/subscriptions/999999/pay', {})).status, 404);
});

// ── Suggestions: detect from recurring transactions, confirm, ignore ─────────
test('suggestions detect a recurring merchant; confirm creates + links; ignore hides it', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;

  // 4 identical monthly charges from the same merchant → a subscription signature.
  for (const d of ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']) {
    await client.post('/api/transactions', { amount: 9.99, account_id: acct, direction: 'expense', txn_date: d, merchant: 'Spotify USA' });
  }
  let sugg = (await client.get('/api/subscriptions/suggestions')).body;
  const s = sugg.find((x: any) => x.merchant.toLowerCase().includes('spotify'));
  assert.ok(s, 'detected the recurring Spotify charge');
  assert.equal(s.billing_cycle, 'monthly');
  assert.ok(s.count >= 3);

  // Confirm requires a merchant.
  assert.equal((await client.post('/api/subscriptions/suggestions/confirm', {})).status, 400);

  // Confirm creates a subscription and retro-links the matched charges.
  const confirm = await client.post('/api/subscriptions/suggestions/confirm', {
    merchant: s.merchant, amount: s.amount, billing_cycle: s.billing_cycle, key: s.key, next_due_date: s.next_due_date,
  });
  assert.equal(confirm.status, 201);
  assert.ok(confirm.body.linked >= 3, 'existing charges linked');
  const newSubId = confirm.body.id;

  // It no longer appears as a suggestion.
  sugg = (await client.get('/api/subscriptions/suggestions')).body;
  assert.ok(!sugg.some((x: any) => x.merchant.toLowerCase().includes('spotify')));

  // Confirming with subscription_id applies the key to an existing subscription.
  const existing = (await client.post('/api/subscriptions', { name: 'Manual', amount: 5, billing_cycle: 'monthly' })).body;
  const applied = await client.post('/api/subscriptions/suggestions/confirm', { merchant: 'Some Other Merchant', subscription_id: existing.id, key: 'some other merchant' });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.id, existing.id);

  // Applying to a missing subscription → 404.
  assert.equal((await client.post('/api/subscriptions/suggestions/confirm', { merchant: 'M', subscription_id: 999999 })).status, 404);

  // Ignore requires a merchant, and hides future suggestions.
  assert.equal((await client.post('/api/subscriptions/suggestions/ignore', {})).status, 400);
  assert.equal((await client.post('/api/subscriptions/suggestions/ignore', { merchant: '   ' })).status, 400);
  // Add another recurring merchant then ignore it.
  for (const d of ['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']) {
    await client.post('/api/transactions', { amount: 12.00, account_id: acct, direction: 'expense', txn_date: d, merchant: 'Hulu Plus' });
  }
  const before = (await client.get('/api/subscriptions/suggestions')).body;
  const hulu = before.find((x: any) => x.merchant.toLowerCase().includes('hulu'));
  assert.ok(hulu);
  assert.equal((await client.post('/api/subscriptions/suggestions/ignore', { merchant: hulu.merchant })).status, 201);
  const after = (await client.get('/api/subscriptions/suggestions')).body;
  assert.ok(!after.some((x: any) => x.merchant.toLowerCase().includes('hulu')));

  assert.ok(newSubId);
});

// ── Documents ────────────────────────────────────────────────────────────────
test('subscription documents: create / list / update / file / delete + validation', async () => {
  const { client } = await registerUser(base);
  const sub = (await client.post('/api/subscriptions', { name: 'S', amount: 5, billing_cycle: 'monthly' })).body;

  // 404 on a missing subscription.
  assert.equal((await client.get('/api/subscriptions/999999/documents')).status, 404);
  // Missing file → 400.
  assert.equal((await client.post(`/api/subscriptions/${sub.id}/documents`, {})).status, 400);
  // Non-string file → 400.
  assert.equal((await client.post(`/api/subscriptions/${sub.id}/documents`, { file: 123, file_mime: 'image/png' })).status, 400);
  // Bad mime → 400.
  assert.equal((await client.post(`/api/subscriptions/${sub.id}/documents`, { file: PNG_B64, file_mime: 'text/html' })).status, 400);

  const doc = await client.post(`/api/subscriptions/${sub.id}/documents`, { file: PNG_B64, file_mime: 'image/png', file_name: 'r.png', doc_type: 'receipt', name: 'Receipt' });
  assert.equal(doc.status, 201);
  const docId = doc.body.id;

  const docs = (await client.get(`/api/subscriptions/${sub.id}/documents`)).body;
  assert.ok(docs.some((d: any) => d.id === docId));

  // Update metadata only.
  const updMeta = await client.put(`/api/subscriptions/${sub.id}/documents/${docId}`, { name: 'Receipt (final)', doc_type: 'contract' });
  assert.equal(updMeta.status, 200);
  assert.equal(updMeta.body.name, 'Receipt (final)');

  // Update replacing the file with a bad mime → 400.
  assert.equal((await client.put(`/api/subscriptions/${sub.id}/documents/${docId}`, { file: PNG_B64, file_mime: 'text/html' })).status, 400);
  // Update replacing the file (valid).
  assert.equal((await client.put(`/api/subscriptions/${sub.id}/documents/${docId}`, { file: PNG_B64, file_mime: 'image/png', file_name: 'n.png', name: 'x' })).status, 200);
  // Update a missing doc → 404.
  assert.equal((await client.put(`/api/subscriptions/${sub.id}/documents/999999`, { name: 'x' })).status, 404);

  // Fetch the stored file.
  assert.equal((await client.get(`/api/subscriptions/${sub.id}/documents/${docId}/file`)).status, 200);
  // File on a missing doc → 404.
  assert.equal((await client.get(`/api/subscriptions/${sub.id}/documents/999999/file`)).status, 404);

  // Delete.
  assert.equal((await client.del(`/api/subscriptions/${sub.id}/documents/${docId}`)).status, 204);

  // Delete the subscription itself.
  assert.equal((await client.del(`/api/subscriptions/${sub.id}`)).status, 204);
});

// ── recurringKey normalization (exported) ────────────────────────────────────
test('recurringKey strips card masks, dates, times, ref numbers, prefixes', async () => {
  const { recurringKey } = await import('../src/routes/subscriptions.js');
  const a = recurringKey('Purchase Openai *chatgpt Subscr Openai.com Ca *****2649 05/23 17:04');
  const b = recurringKey('POS DEBIT Openai *chatgpt Subscr Openai.com Ca xxxx1234 06/24 09:10');
  assert.equal(a, b, 'the same subscription collapses despite per-charge noise');
  assert.ok(a.includes('openai'));
});
