import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('create validation, update, and delete untags transactions', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;

  // name required.
  assert.equal((await client.post('/api/vehicles', {})).status, 400);
  // bad numeric field → 400.
  assert.equal((await client.post('/api/vehicles', { name: 'X', purchase_price: 'abc' })).status, 400);
  // bad date → 400.
  assert.equal((await client.post('/api/vehicles', { name: 'X', purchase_date: 'not-a-date' })).status, 400);

  const veh = (await client.post('/api/vehicles', { name: 'Car', make: 'Toyota', model: 'Camry', year: 2020, current_value: 15000 })).body;

  // Update partial (name COALESCE keeps existing when null).
  const upd = await client.put(`/api/vehicles/${veh.id}`, { make: 'Honda', model: 'Accord', current_value: 14000 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.make, 'Honda');
  assert.equal(Number(upd.body.current_value), 14000);
  // Update a bad value on PUT → 400.
  assert.equal((await client.put(`/api/vehicles/${veh.id}`, { year: 'xx' })).status, 400);
  // 404 for missing vehicle.
  assert.equal((await client.put('/api/vehicles/999999', { name: 'z' })).status, 404);

  // Tag a transaction to the vehicle, then delete the vehicle → the tag is removed.
  await client.post('/api/transactions', { amount: 20, account_id: acct, direction: 'expense', txn_date: '2026-06-01', tags: [{ kind: 'vehicle', ref_id: veh.id }] });
  assert.equal((await client.del(`/api/vehicles/${veh.id}`)).status, 204);
  assert.ok(!((await client.get('/api/vehicles')).body as any[]).some((v) => v.id === veh.id));
  // The formerly-tagged transaction is no longer returned for that (deleted) vehicle.
  const tagged = (await client.get(`/api/transactions?vehicle_id=${veh.id}`)).body;
  assert.equal(tagged.posted.length + tagged.pending.length, 0);
});

test('reorder persists sort_order', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/vehicles', { name: 'AAA' })).body.id;
  const b = (await client.post('/api/vehicles', { name: 'BBB' })).body.id;
  assert.equal((await client.post('/api/vehicles/reorder', { ids: [b, a] })).status, 200);
  const list = (await client.get('/api/vehicles')).body as any[];
  assert.deepEqual(list.map((v) => v.name), ['BBB', 'AAA']);
});

test('miles-driven aggregates odometer deltas by month (optional vehicle filter)', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Truck', odometer_start: 1000 })).body;
  await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 2000, as_of: '2026-01-01' });
  await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 4000, as_of: '2026-04-01' });

  const all = await client.get('/api/vehicles/miles-driven');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body));
  assert.ok(all.body.length >= 1, 'spread produces at least one month');
  const totalMiles = all.body.reduce((s: number, r: any) => s + Number(r.miles), 0);
  assert.ok(totalMiles > 0);

  // Narrowed to a single vehicle.
  const one = await client.get(`/api/vehicles/miles-driven?vehicle_id=${veh.id}`);
  assert.equal(one.status, 200);
});

test('loan-account: create fresh, link existing, list candidates, unlink', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Financed' })).body;

  // No loan accounts yet.
  assert.deepEqual((await client.get('/api/vehicles/loan-accounts')).body, []);

  // Create a fresh loan account seeded with an opening balance.
  const created = await client.post(`/api/vehicles/${veh.id}/loan-account`, { opening_balance: 12000 });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'loan');
  assert.equal(created.body.is_liability, true);
  assert.match(created.body.name, /Loan$/);

  // Posting again returns the already-linked account (idempotent).
  const again = await client.post(`/api/vehicles/${veh.id}/loan-account`, {});
  assert.equal(again.body.id, created.body.id);

  // 404 for an unknown vehicle.
  assert.equal((await client.post('/api/vehicles/999999/loan-account', {})).status, 404);

  // Unlink, then link an already-existing loan account by id.
  assert.equal((await client.del(`/api/vehicles/${veh.id}/loan-account`)).status, 204);
  const existingLoan = (await client.post('/api/accounts', { name: 'Standalone Loan', type: 'loan', is_liability: true })).body.id;
  const linked = await client.post(`/api/vehicles/${veh.id}/loan-account`, { account_id: existingLoan });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.id, existingLoan);

  // Linking a nonexistent account → 404.
  assert.equal((await client.del(`/api/vehicles/${veh.id}/loan-account`)).status, 204);
  assert.equal((await client.post(`/api/vehicles/${veh.id}/loan-account`, { account_id: 999999 })).status, 404);
});

test('VIN decode rejects malformed VINs (400) without a network call', async () => {
  const { client } = await registerUser(base);
  const bad = await client.get('/api/vehicles/decode/SHORT');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /valid VIN/i);
});

test('estimate-value validates input before calling the AI', async () => {
  const { client } = await registerUser(base);
  // Nothing to estimate from → 400.
  const empty = await client.post('/api/vehicles/estimate-value', {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /make, model, or year/);
  // Bad numeric year → 400.
  assert.equal((await client.post('/api/vehicles/estimate-value', { year: 'nineteen' })).status, 400);

  // With valid inputs the AI is invoked. The outcome depends on whether a key is
  // configured in the environment (503 not-configured, 200 ok, or 5xx on an API/parse
  // error) — assert only that it got past validation to the AI call.
  const est = await client.post('/api/vehicles/estimate-value', { make: 'Toyota', model: 'Camry', year: 2020, odometer_current: 50000 });
  assert.ok([200, 500, 502, 503].includes(est.status), `unexpected estimate status ${est.status}`);
});

test('proceeds-candidates and expense-candidates list relevant transactions', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body;

  // Income candidate (for proceeds linking).
  await client.post('/api/transactions', { amount: 9000, account_id: acct, direction: 'income', txn_date: '2026-06-01', merchant: 'CarMax' });
  const proceeds = await client.get(`/api/vehicles/${veh.id}/proceeds-candidates`);
  assert.equal(proceeds.status, 200);
  assert.ok(proceeds.body.length >= 1);

  // Expense tagged to the vehicle (for maintenance linking).
  await client.post('/api/transactions', { amount: 50, account_id: acct, direction: 'expense', txn_date: '2026-06-02', merchant: 'Shop', tags: [{ kind: 'vehicle', ref_id: veh.id }] });
  const expenses = await client.get(`/api/vehicles/${veh.id}/expense-candidates`);
  assert.equal(expenses.status, 200);
  assert.equal(expenses.body.length, 1);
});

test('dispose: idempotency guard and proceeds validation', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Van', current_value: 5000 })).body;

  // proceeds_mode 'create' without a sale amount → 400.
  const noAmount = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: true, disposal_type: 'sold', proceeds_mode: 'create', proceeds_account_id: acct });
  assert.equal(noAmount.status, 400);
  assert.match(noAmount.body.error, /sale amount/);

  // Dispose it for real.
  const disp = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: true, disposal_type: 'sold', disposal_amount: 4500 });
  assert.equal(disp.status, 200);

  // Disposing an already-disposed vehicle → 409.
  const again = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: true, disposal_type: 'sold', disposal_amount: 4500 });
  assert.equal(again.status, 409);

  // proceeds_mode 'link' to a nonexistent transaction → 404.
  await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: false });
  const badLink = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: true, disposal_type: 'sold', proceeds_mode: 'link', disposal_transaction_id: 999999 });
  assert.equal(badLink.status, 404);
});

test('maintenance documents: upload, list, and required file', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Truck' })).body;
  const m = (await client.post(`/api/vehicles/${veh.id}/maintenance`, { item: 'Oil', status: 'completed', service_date: '2026-05-01', cost: 40 })).body;

  // file required.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/maintenance/${m.id}/documents`, {})).status, 400);
  // Missing maintenance record → 404.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/maintenance/999999/documents`, { file: 'aGk=', file_mime: 'application/pdf', file_name: 'x.pdf' })).status, 404);
  // Disallowed MIME → 400.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/maintenance/${m.id}/documents`, { file: 'aGk=', file_mime: 'text/html', file_name: 'x.html' })).status, 400);

  const up = await client.post(`/api/vehicles/${veh.id}/maintenance/${m.id}/documents`, { file: 'aGVsbG8=', file_mime: 'application/pdf', file_name: 'receipt.pdf', name: 'Receipt' });
  assert.equal(up.status, 201);

  const list = (await client.get(`/api/vehicles/${veh.id}/maintenance/${m.id}/documents`)).body as any[];
  assert.equal(list.length, 1);
});

test('vehicle documents: metadata update and file replacement', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body;
  const up = (await client.post(`/api/vehicles/${veh.id}/documents`, { file: 'aGVsbG8=', file_mime: 'application/pdf', file_name: 'title.pdf', doc_type: 'title' })).body;

  // Metadata-only update.
  const meta = await client.put(`/api/vehicles/${veh.id}/documents/${up.id}`, { name: 'Vehicle Title', doc_type: 'title' });
  assert.equal(meta.status, 200);
  assert.equal(meta.body.name, 'Vehicle Title');
  // File-replacement update.
  const repl = await client.put(`/api/vehicles/${veh.id}/documents/${up.id}`, { name: 'T2', file: 'd29ybGQ=', file_mime: 'image/png', file_name: 'title.png' });
  assert.equal(repl.status, 200);
  // Bad MIME on replace → 400.
  assert.equal((await client.put(`/api/vehicles/${veh.id}/documents/${up.id}`, { file: 'd29ybGQ=', file_mime: 'text/html' })).status, 400);
  // Missing doc → 404.
  assert.equal((await client.put(`/api/vehicles/${veh.id}/documents/999999`, { name: 'z' })).status, 404);
});
