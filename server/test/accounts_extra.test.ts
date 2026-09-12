import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('create: validation, defaults, and type-specific fields; update partial + 404', async () => {
  const { client } = await registerUser(base);
  // name required.
  assert.equal((await client.post('/api/accounts', {})).status, 400);
  // invalid type → 400.
  assert.equal((await client.post('/api/accounts', { name: 'X', type: 'nonsense' })).status, 400);
  // non-numeric money field → 400 via coercer.
  assert.equal((await client.post('/api/accounts', { name: 'X', opening_balance: 'abc' })).status, 400);

  // Defaults: no type → checking, currency USD, is_liability false.
  const def = await client.post('/api/accounts', { name: 'Default' });
  assert.equal(def.status, 201);
  assert.equal(def.body.type, 'checking');
  assert.equal(def.body.currency, 'USD');
  assert.equal(def.body.is_liability, false);

  // A loan account with loan/card capability fields set.
  const loan = await client.post('/api/accounts', {
    name: 'Car Loan', type: 'loan', is_liability: true, is_loan: true,
    loan_original_principal: 20000, loan_term_months: 60, loan_payment_amount: 400,
    interest_rate: 4.125, opening_balance: -18000, opening_date: '2026-01-01',
  });
  assert.equal(loan.status, 201);
  assert.equal(loan.body.is_loan, true);
  assert.equal(Number(loan.body.loan_original_principal), 20000);
  assert.equal(loan.body.loan_term_months, 60);

  // Partial update writes only present columns.
  const upd = await client.put(`/api/accounts/${loan.body.id}`, { name: 'Auto Loan', credit_limit: 0 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Auto Loan');
  assert.equal(upd.body.loan_term_months, 60, 'omitted columns unchanged');

  // Update with no writable fields → returns the row unchanged.
  const noop = await client.put(`/api/accounts/${loan.body.id}`, { unknown_field: 1 });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.id, loan.body.id);

  // Update with a bad type → 400.
  assert.equal((await client.put(`/api/accounts/${loan.body.id}`, { type: 'bogus' })).status, 400);
  // Update a missing account → 404.
  assert.equal((await client.put('/api/accounts/999999', { name: 'z' })).status, 404);
});

test('delete: refuses accounts with history (409), removes unused ones, 404 on missing', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Fresh', type: 'checking' })).body.id;
  // No history → hard delete.
  assert.equal((await client.del(`/api/accounts/${acct}`)).status, 204);
  // 404 on missing.
  assert.equal((await client.del('/api/accounts/999999')).status, 404);

  // With a transaction → 409 (must archive/close instead).
  const used = (await client.post('/api/accounts', { name: 'Used', type: 'checking' })).body.id;
  await client.post('/api/transactions', { amount: 5, account_id: used, direction: 'expense', txn_date: '2026-06-01' });
  const refused = await client.del(`/api/accounts/${used}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Archive or close/);
});

test('reorder persists sort_order', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/accounts', { name: 'AAA', type: 'checking' })).body.id;
  const b = (await client.post('/api/accounts', { name: 'BBB', type: 'checking' })).body.id;
  const c = (await client.post('/api/accounts', { name: 'CCC', type: 'checking' })).body.id;
  assert.equal((await client.post('/api/accounts/reorder', { ids: [c, a, b] })).status, 200);
  const list = (await client.get('/api/accounts')).body as any[];
  assert.deepEqual(list.map((x) => x.name), ['CCC', 'AAA', 'BBB']);
});

test('archive / reactivate and status transitions', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Arch', type: 'checking' })).body.id;

  const arch = await client.post(`/api/accounts/${acct}/archive`, {});
  assert.equal(arch.status, 200);
  assert.ok(arch.body.archived_at != null);
  assert.equal((await client.get(`/api/accounts/${acct}`)).body.status, 'archived');

  // Reactivate.
  const react = await client.post(`/api/accounts/${acct}/archive`, { archived: false });
  assert.equal(react.body.archived_at, null);
  assert.equal((await client.get(`/api/accounts/${acct}`)).body.status, 'active');

  // 404 for a missing account.
  assert.equal((await client.post('/api/accounts/999999/archive', {})).status, 404);
});

test('close: immediate archives now, future schedules, reopen clears', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Close', type: 'checking' })).body.id;

  // Immediate close (past date) archives now.
  const closed = await client.post(`/api/accounts/${acct}/close`, { closed: true, closed_at: '2020-01-01', close_reason: 'done' });
  assert.equal(closed.status, 200);
  assert.equal((await client.get(`/api/accounts/${acct}`)).body.status, 'closed');

  // Reopen clears closed_at + archived_at.
  const reopened = await client.post(`/api/accounts/${acct}/close`, { closed: false });
  assert.equal(reopened.body.closed_at, null);
  assert.equal((await client.get(`/api/accounts/${acct}`)).body.status, 'active');

  // Future close date schedules but stays active until the sweep.
  const future = await client.post(`/api/accounts/${acct}/close`, { closed: true, closed_at: '2099-01-01' });
  assert.equal(future.status, 200);
  assert.ok(future.body.closed_at);
  // Still active because the close date is in the future.
  assert.equal((await client.get(`/api/accounts/${acct}`)).body.status, 'active');

  // 404 for a missing account.
  assert.equal((await client.post('/api/accounts/999999/close', {})).status, 404);
});

test('balances: record snapshot, list, adjustments/events, delete snapshot', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Bal', type: 'checking', opening_balance: 0 })).body.id;

  // Record two dated snapshots; the second overwrites nothing (different date).
  const b1 = await client.post(`/api/accounts/${acct}/balances`, { balance: 1000, as_of: '2026-01-01', reason: 'initial' });
  assert.equal(b1.status, 201);
  const b2 = await client.post(`/api/accounts/${acct}/balances`, { balance: 1500, as_of: '2026-02-01' });
  assert.equal(b2.status, 201);
  // Overwrite the first date (upsert path) — captures previous_balance in the audit.
  await client.post(`/api/accounts/${acct}/balances`, { balance: 1100, as_of: '2026-01-01' });

  const balances = (await client.get(`/api/accounts/${acct}/balances`)).body as any[];
  assert.equal(balances.length, 2, 'same-date snapshot upserted, not duplicated');

  // Balance-events ledger has snapshot rows (one per POST).
  const events = (await client.get(`/api/accounts/${acct}/balance-events`)).body as any[];
  assert.ok(events.length >= 2);

  // Adjustments audit trail is append-only (3 POSTs → 3 rows).
  const adj = (await client.get(`/api/accounts/${acct}/adjustments`)).body as any[];
  assert.equal(adj.length, 3);

  // Delete one snapshot → voids the matching ledger event.
  const target = balances.find((r) => r.as_of.slice(0, 10) === '2026-02-01');
  assert.equal((await client.del(`/api/accounts/${acct}/balances/${target.id}`)).status, 204);
  assert.equal((await client.get(`/api/accounts/${acct}/balances`)).body.length, 1);
  const eventsAfter = (await client.get(`/api/accounts/${acct}/balance-events`)).body as any[];
  assert.ok(!eventsAfter.some((e: any) => e.as_of.slice(0, 10) === '2026-02-01'), 'voided event dropped from the ledger');

  // A bad balance value → 400.
  assert.equal((await client.post(`/api/accounts/${acct}/balances`, { balance: 'nope' })).status, 400);
});

test('holdings endpoint returns an (empty) list for accounts without positions', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Inv', type: 'investment' })).body.id;
  const r = await client.get(`/api/accounts/${acct}/holdings`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('documents: upload with MIME validation, list, fetch file, update, delete', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Docs', type: 'checking' })).body.id;

  // file required.
  assert.equal((await client.post(`/api/accounts/${acct}/documents`, {})).status, 400);
  // Disallowed MIME → 400.
  assert.equal((await client.post(`/api/accounts/${acct}/documents`, { file: 'aGk=', file_mime: 'text/html', file_name: 'x.html' })).status, 400);
  // Non-string file → 400.
  assert.equal((await client.post(`/api/accounts/${acct}/documents`, { file: 123, file_mime: 'application/pdf' })).status, 400);

  const up = await client.post(`/api/accounts/${acct}/documents`, { file: 'aGVsbG8=', file_mime: 'application/pdf', file_name: 'statement.pdf', doc_type: 'statement' });
  assert.equal(up.status, 201);
  assert.equal(up.body.doc_type, 'statement');

  const list = (await client.get(`/api/accounts/${acct}/documents`)).body as any[];
  assert.equal(list.length, 1);

  // Fetch the file with hardened headers.
  const file = await fetch(`${base}/api/accounts/${acct}/documents/${up.body.id}/file`, { headers: { cookie: client.cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  // Missing doc file → 404.
  const missing = await client.get(`/api/accounts/${acct}/documents/999999/file`);
  assert.equal(missing.status, 404);

  // Update metadata only.
  const meta = await client.put(`/api/accounts/${acct}/documents/${up.body.id}`, { name: 'Renamed', doc_type: 'tax' });
  assert.equal(meta.status, 200);
  assert.equal(meta.body.name, 'Renamed');
  assert.equal(meta.body.doc_type, 'tax');

  // Update replacing the file (base64 path).
  const repl = await client.put(`/api/accounts/${acct}/documents/${up.body.id}`, { name: 'New', file: 'd29ybGQ=', file_mime: 'image/png', file_name: 'n.png' });
  assert.equal(repl.status, 200);
  // Update replacing with a bad MIME → 400.
  assert.equal((await client.put(`/api/accounts/${acct}/documents/${up.body.id}`, { file: 'd29ybGQ=', file_mime: 'text/html' })).status, 400);
  // Update a missing doc → 404.
  assert.equal((await client.put(`/api/accounts/${acct}/documents/999999`, { name: 'z' })).status, 404);

  // Delete.
  assert.equal((await client.del(`/api/accounts/${acct}/documents/${up.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/accounts/${acct}/documents`)).body.length, 0);
});

test('beneficiaries: create, list, update, delete + required name', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Ben', type: 'retirement' })).body.id;

  // name required.
  assert.equal((await client.post(`/api/accounts/${acct}/beneficiaries`, {})).status, 400);

  const primary = await client.post(`/api/accounts/${acct}/beneficiaries`, { name: 'Alice', relationship: 'spouse', kind: 'primary', percentage: 60 });
  assert.equal(primary.status, 201);
  assert.equal(primary.body.kind, 'primary');
  const contingent = await client.post(`/api/accounts/${acct}/beneficiaries`, { name: 'Bob', kind: 'contingent', percentage: 40 });
  assert.equal(contingent.body.kind, 'contingent');

  const list = (await client.get(`/api/accounts/${acct}/beneficiaries`)).body as any[];
  assert.equal(list.length, 2);

  // Update.
  const upd = await client.put(`/api/accounts/${acct}/beneficiaries/${primary.body.id}`, { name: 'Alice B', relationship: 'wife', kind: 'primary', percentage: 70 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Alice B');
  // Update a missing beneficiary → 404.
  assert.equal((await client.put(`/api/accounts/${acct}/beneficiaries/999999`, { name: 'z' })).status, 404);

  // Delete one.
  assert.equal((await client.del(`/api/accounts/${acct}/beneficiaries/${contingent.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/accounts/${acct}/beneficiaries`)).body.length, 1);
});

test('sub-resource endpoints are tenant scoped (404 across books)', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acctA = (await a.client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;

  for (const path of [
    `/api/accounts/${acctA}/balances`,
    `/api/accounts/${acctA}/holdings`,
    `/api/accounts/${acctA}/balance-events`,
    `/api/accounts/${acctA}/adjustments`,
    `/api/accounts/${acctA}/documents`,
    `/api/accounts/${acctA}/beneficiaries`,
  ]) {
    assert.equal((await b.client.get(path)).status, 404, `${path} is book-scoped`);
  }
  assert.equal((await b.client.post(`/api/accounts/${acctA}/balances`, { balance: 1 })).status, 404);
  assert.equal((await b.client.post(`/api/accounts/${acctA}/beneficiaries`, { name: 'x' })).status, 404);
});
