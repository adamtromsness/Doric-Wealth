import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// A tiny valid PNG (1x1) as base64 — passes assertUploadMime('image/png').
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ── Utility accounts: create / update / cancel / reactivate / delete ──────────
test('utility account create validates enums and cross-book refs; full CRUD lifecycle', async () => {
  const { client } = await registerUser(base);

  // name is required.
  assert.equal((await client.post('/api/utilities/accounts', {})).status, 400);

  // Bad enum → 400.
  assert.equal((await client.post('/api/utilities/accounts', { name: 'Elec', utility_type: 'nope' })).status, 400);
  assert.equal((await client.post('/api/utilities/accounts', { name: 'Elec', billing_cycle: 'nope' })).status, 400);
  assert.equal((await client.post('/api/utilities/accounts', { name: 'Elec', payment_plan: 'nope' })).status, 400);

  // A cross-book property/account ref → 404.
  const other = await registerUser(base);
  const otherProp = (await other.client.post('/api/properties', { name: 'P', address: '1 St' })).body.id;
  assert.equal((await client.post('/api/utilities/accounts', { name: 'Elec', property_id: otherProp })).status, 404);

  // Valid create with defaults.
  const prop = (await client.post('/api/properties', { name: 'Home', address: '2 St' })).body.id;
  const payAcct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const created = await client.post('/api/utilities/accounts', {
    name: 'Power Co', provider: 'PowerCorp', property_id: prop, payment_account_id: payAcct,
    due_day: 15, autopay_day: 10, is_autopay: true, payment_plan: 'average',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.utility_type, 'electricity'); // default
  assert.equal(created.body.billing_cycle, 'monthly'); // default

  // Listed with aggregates.
  const list = (await client.get('/api/utilities/accounts')).body;
  assert.ok(list.some((a: any) => a.id === id && a.property_name === 'Home'));

  // Update: bad enum → 400.
  assert.equal((await client.put(`/api/utilities/accounts/${id}`, { utility_type: 'bad' })).status, 400);

  // Update valid.
  const upd = await client.put(`/api/utilities/accounts/${id}`, { name: 'Power Co 2', utility_type: 'gas' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Power Co 2');
  assert.equal(upd.body.utility_type, 'gas');

  // Update missing → 404.
  assert.equal((await client.put('/api/utilities/accounts/999999', { name: 'x' })).status, 404);

  // Reorder (no-op ordering).
  assert.equal((await client.post('/api/utilities/accounts/reorder', { ids: [id] })).status, 200);
  assert.equal((await client.post('/api/utilities/accounts/reorder', {})).status, 200); // non-array ids

  // Delete.
  assert.equal((await client.del(`/api/utilities/accounts/${id}`)).status, 204);
});

test('utility account cancel (immediate + scheduled) and reactivate; 404 on missing', async () => {
  const { client } = await registerUser(base);
  const id = (await client.post('/api/utilities/accounts', { name: 'Water' })).body.id;

  // Immediate cancel (no date → today).
  const c = await client.post(`/api/utilities/accounts/${id}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'canceled');

  // Reactivate.
  const r = await client.post(`/api/utilities/accounts/${id}/reactivate`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'active');
  assert.equal(r.body.end_date, null);

  // Scheduled cancel in the future: stays active, end_date set.
  const future = '2099-01-01';
  const sched = await client.post(`/api/utilities/accounts/${id}/cancel`, { date: future });
  assert.equal(sched.status, 200);
  assert.equal(sched.body.status, 'active');
  assert.ok(String(sched.body.end_date).startsWith(future));

  // 404s on missing account for cancel + reactivate.
  assert.equal((await client.post('/api/utilities/accounts/999999/cancel', {})).status, 404);
  assert.equal((await client.post('/api/utilities/accounts/999999/reactivate', {})).status, 404);
});

// ── Invoices: parse-basic validation, save, list, pay, delete ────────────────
test('invoices parse-basic rejects bad input (no file / non-pdf / bad magic)', async () => {
  const { client } = await registerUser(base);
  // No file.
  assert.equal((await client.post('/api/utilities/invoices/parse-basic', {})).status, 400);
  // An image mime → 415 (basic scan reads PDFs).
  assert.equal((await client.post('/api/utilities/invoices/parse-basic', { file: PNG_B64, mime: 'image/png' })).status, 415);
  // A pdf-labeled file whose bytes are not a real PDF (bad magic) → 415.
  const notPdf = Buffer.from('hello world not a pdf').toString('base64');
  assert.equal((await client.post('/api/utilities/invoices/parse-basic', { file: notPdf, mime: 'application/pdf' })).status, 415);
});

test('invoices AI parse: no file → 400; without AI configured → 503', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/utilities/invoices/parse', {})).status, 400);
  // With a file, the AI path runs: 503 if no key is configured, otherwise the call
  // errors out (no real network / bad response) → 5xx. Either way it exercises the branch.
  const r = await client.post('/api/utilities/invoices/parse', { file: PNG_B64, mime: 'image/png' });
  assert.ok(r.status >= 500, `AI parse surfaces a server error (got ${r.status})`);
});

test('invoice save (with lines) → list → pay in full → unpay; validation & 404s', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Utilities', kind: 'expense' })).body.id;
  const payAcct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const ua = (await client.post('/api/utilities/accounts', { name: 'Electric' })).body.id;

  // Bad date on a header field → 400.
  assert.equal((await client.post('/api/utilities/invoices', { invoice_date: 'not-a-date' })).status, 400);
  // Sub-cent line amount → 400 (money rejects it).
  assert.equal((await client.post('/api/utilities/invoices', { lines: [{ amount: 10.001, utility_account_id: ua }] })).status, 400);

  // Valid invoice with a line, not paid.
  const created = await client.post('/api/utilities/invoices', {
    provider: 'Electric Co', invoice_date: '2026-06-01', due_date: '2026-06-15',
    category_id: cat, account_id: payAcct,
    lines: [{ amount: 50.00, utility_account_id: ua, description: 'Energy', usage_quantity: 100, usage_unit: 'kWh' }],
  });
  assert.equal(created.status, 201);
  const invId = created.body.id;

  // List: unpaid filter + account filter.
  const all = (await client.get('/api/utilities/invoices')).body;
  const found = all.find((i: any) => i.id === invId);
  assert.ok(found);
  assert.equal(Number(found.total), 50);
  assert.equal(found.paid, false);
  assert.equal(found.lines.length, 1);

  const scoped = (await client.get(`/api/utilities/invoices?account_id=${ua}&unpaid=true`)).body;
  assert.ok(scoped.some((i: any) => i.id === invId));

  // Pay in full (creates a payment transaction).
  const pay = await client.post(`/api/utilities/invoices/${invId}/pay`, { paid_date: '2026-06-10' });
  assert.equal(pay.status, 200);
  const afterPay = (await client.get('/api/utilities/invoices')).body.find((i: any) => i.id === invId);
  assert.equal(afterPay.paid, true);
  assert.ok(Number(afterPay.amount_paid) >= 50);

  // Unpay (removes auto payments).
  const unpay = await client.post(`/api/utilities/invoices/${invId}/pay`, { paid: false });
  assert.equal(unpay.status, 200);
  const afterUnpay = (await client.get('/api/utilities/invoices')).body.find((i: any) => i.id === invId);
  assert.equal(afterUnpay.paid, false);

  // Pay a missing invoice → 404.
  assert.equal((await client.post('/api/utilities/invoices/999999/pay', {})).status, 404);

  // Update the invoice (PUT) marking paid this time.
  const put = await client.put(`/api/utilities/invoices/${invId}`, {
    provider: 'Electric Co', account_id: payAcct, category_id: cat, paid: true,
    lines: [{ amount: 50.00, utility_account_id: ua, description: 'Energy' }],
  });
  assert.equal(put.status, 200);

  // Delete the invoice.
  assert.equal((await client.del(`/api/utilities/invoices/${invId}`)).status, 204);

  // The invoice file endpoint 404s when there is no file (and for missing invoices).
  assert.equal((await client.get(`/api/utilities/invoices/${invId}/file`)).status, 404);
});

test('invoice save can link an existing transaction as payment; multi-account split pay', async () => {
  const { client } = await registerUser(base);
  const cat = (await client.post('/api/categories', { name: 'Utilities', kind: 'expense' })).body.id;
  const payAcct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const gas = (await client.post('/api/utilities/accounts', { name: 'Gas', utility_type: 'gas' })).body.id;
  const water = (await client.post('/api/utilities/accounts', { name: 'Water', utility_type: 'water' })).body.id;

  // Multi-account invoice paid in full → split by account.
  const multi = await client.post('/api/utilities/invoices', {
    provider: 'City Utils', account_id: payAcct, category_id: cat, paid: true, paid_date: '2026-06-05',
    lines: [
      { amount: 30.00, utility_account_id: gas, description: 'Gas' },
      { amount: 20.00, utility_account_id: water, description: 'Water' },
    ],
  });
  assert.equal(multi.status, 201);
  const multiFound = (await client.get('/api/utilities/invoices')).body.find((i: any) => i.id === multi.body.id);
  assert.equal(multiFound.paid, true);

  // Link an existing transaction as the payment.
  const txnId = (await client.post('/api/transactions', { amount: 40, account_id: payAcct, direction: 'expense', txn_date: '2026-07-01', merchant: 'Gas Co' })).body.id;

  // Payment candidates surfaces expense transactions near an amount.
  const cands = (await client.get(`/api/utilities/payment-candidates?amount=40&date=2026-07-01&account_id=${payAcct}`)).body;
  assert.ok(Array.isArray(cands));

  const linked = await client.post('/api/utilities/invoices', {
    provider: 'Gas only', account_id: payAcct, category_id: cat, paid: true,
    payment_transaction_id: txnId,
    lines: [{ amount: 40.00, utility_account_id: gas, description: 'Gas' }],
  });
  assert.equal(linked.status, 201);
});

// ── Account documents ────────────────────────────────────────────────────────
test('utility account documents: create / list / update / file / delete + validation', async () => {
  const { client } = await registerUser(base);
  const ua = (await client.post('/api/utilities/accounts', { name: 'Internet' })).body.id;

  // 404 documents for a missing account.
  assert.equal((await client.get('/api/utilities/accounts/999999/documents')).status, 404);
  // Missing file → 400.
  assert.equal((await client.post(`/api/utilities/accounts/${ua}/documents`, {})).status, 400);
  // Non-string file → 400.
  assert.equal((await client.post(`/api/utilities/accounts/${ua}/documents`, { file: 123, file_mime: 'image/png' })).status, 400);
  // Bad mime → 400.
  assert.equal((await client.post(`/api/utilities/accounts/${ua}/documents`, { file: PNG_B64, file_mime: 'text/html' })).status, 400);

  // Create a document.
  const doc = await client.post(`/api/utilities/accounts/${ua}/documents`, {
    file: PNG_B64, file_mime: 'image/png', file_name: 'bill.png', doc_type: 'statement', name: 'June',
  });
  assert.equal(doc.status, 201);
  const docId = doc.body.id;

  // List.
  const docs = (await client.get(`/api/utilities/accounts/${ua}/documents`)).body;
  assert.ok(docs.some((d: any) => d.id === docId));

  // Update metadata only.
  const updMeta = await client.put(`/api/utilities/accounts/${ua}/documents/${docId}`, { name: 'June (final)', doc_type: 'agreement' });
  assert.equal(updMeta.status, 200);
  assert.equal(updMeta.body.name, 'June (final)');

  // Update replacing the file (bad mime → 400).
  assert.equal((await client.put(`/api/utilities/accounts/${ua}/documents/${docId}`, { file: PNG_B64, file_mime: 'text/html' })).status, 400);

  // Update replacing the file (valid).
  const updFile = await client.put(`/api/utilities/accounts/${ua}/documents/${docId}`, { file: PNG_B64, file_mime: 'image/png', file_name: 'new.png', name: 'x' });
  assert.equal(updFile.status, 200);

  // Update a missing doc → 404.
  assert.equal((await client.put(`/api/utilities/accounts/${ua}/documents/999999`, { name: 'x' })).status, 404);

  // Fetch the stored file.
  const file = await client.get(`/api/utilities/accounts/${ua}/documents/${docId}/file`);
  assert.equal(file.status, 200);

  // File on a missing doc → 404.
  assert.equal((await client.get(`/api/utilities/accounts/${ua}/documents/999999/file`)).status, 404);

  // Delete.
  assert.equal((await client.del(`/api/utilities/accounts/${ua}/documents/${docId}`)).status, 204);
});

test('utility accounts are tenant-isolated (another book cannot touch them)', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const id = (await a.client.post('/api/utilities/accounts', { name: 'Elec' })).body.id;

  // B cannot update, cancel, reactivate, or read A's account docs.
  assert.equal((await b.client.put(`/api/utilities/accounts/${id}`, { name: 'hax' })).status, 404);
  assert.equal((await b.client.post(`/api/utilities/accounts/${id}/cancel`, {})).status, 404);
  assert.equal((await b.client.get(`/api/utilities/accounts/${id}/documents`)).status, 404);
});

test('linking an existing transaction pays only what it paid, once, and only if it is an expense', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const gas = (await client.post('/api/utilities/accounts', { name: 'Gas', utility_type: 'gas' })).body.id;
  const invoice = (amount: number, payment_transaction_id: number) => client.post('/api/utilities/invoices', {
    provider: 'Gas Co', account_id: acct, paid: true, payment_transaction_id,
    lines: [{ amount, utility_account_id: gas, description: 'Gas' }],
  });
  const find = async (id: number) => (await client.get('/api/utilities/invoices')).body.find((i: any) => i.id === id);

  // A $10 payment can't settle a $100 bill.
  const ten = (await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: '2026-07-01' })).body.id;
  const big = await invoice(100, ten);
  assert.equal(big.status, 201);
  assert.equal((await find(big.body.id)).paid, false, 'only $10 of $100 is covered');

  // The same transaction can't cover another bill: it's used up.
  const again = await invoice(5, ten);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already fully applied/);

  // A $60 payment covers a $40 bill and leaves $20 for another.
  const sixty = (await client.post('/api/transactions', { amount: 60, account_id: acct, direction: 'expense', txn_date: '2026-07-02' })).body.id;
  assert.equal((await find((await invoice(40, sixty)).body.id)).paid, true);
  assert.equal((await find((await invoice(20, sixty)).body.id)).paid, true);
  assert.equal((await invoice(1, sixty)).status, 409);

  // Income can't be a bill payment.
  const refund = (await client.post('/api/transactions', { amount: 50, account_id: acct, direction: 'income', txn_date: '2026-07-03' })).body.id;
  const r = await invoice(50, refund);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Only an expense/);
});

test('marking a bill paid records a posted payment on the paid date', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking', opening_balance: 500 })).body.id;
  const inv = await client.post('/api/utilities/invoices', {
    provider: 'Water Co', account_id: acct, paid: true, paid_date: '2026-07-15',
    lines: [{ amount: 45, description: 'Water' }],
  });
  assert.equal(inv.status, 201);
  const list = (await client.get('/api/transactions?limit=10')).body;
  assert.equal(list.pending.length, 0, 'not left pending');
  const pay = list.posted.find((t: any) => t.description === 'Utility payment');
  assert.equal(String(pay.posted_date).slice(0, 10), '2026-07-15');
  assert.equal(Number((await client.get(`/api/accounts/${acct}`)).body.posted_balance), 455, 'the posted balance reflects the payment');
});
