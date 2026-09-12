import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Fetch one account (with its import-status fields) from the account list.
async function getAccount(client: any, id: number) {
  const list = (await client.get('/api/accounts')).body;
  return list.find((a: any) => a.id === id);
}

test('import status: staging sets status=staged, single confirm sets imported', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;

  // Before any import there is no status.
  let a = await getAccount(client, acct);
  assert.equal(a.last_import_status, null);
  assert.equal(a.last_import_at, null);

  // Staging an import sets status=staged with a timestamp.
  const csv = 'Date,Description,Amount\n2026-06-10,COFFEE SHOP,-4.50';
  const imp = await client.post('/api/imports', { text: csv, account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 }, amountsNegativeAreExpense: true });
  assert.equal(imp.status, 201);
  a = await getAccount(client, acct);
  assert.equal(a.last_import_status, 'staged');
  assert.ok(a.last_import_at, 'last_import_at should be set after staging');
  assert.equal(a.last_import_error, null);

  // Confirming a single staged row flips status to imported.
  const staged = (await client.get('/api/imports/staged')).body;
  const conf = await client.post(`/api/imports/staged/${staged[0].id}/confirm`);
  assert.equal(conf.status, 201);
  a = await getAccount(client, acct);
  assert.equal(a.last_import_status, 'imported');
  assert.ok(a.last_import_at);
});

test('import status: bulk confirm sets imported', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card' })).body.id;

  const csv = 'Date,Description,Amount\n2026-06-01,STORE A,-10.00\n2026-06-02,STORE B,-20.00';
  await client.post('/api/imports', { text: csv, account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 }, amountsNegativeAreExpense: true });
  assert.equal((await getAccount(client, acct)).last_import_status, 'staged');

  const bulk = await client.post('/api/imports/staged/confirm', {});
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.imported, 2);
  const a = await getAccount(client, acct);
  assert.equal(a.last_import_status, 'imported');
});

test('import status: an import that stages nothing is marked failed with an error', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Savings', type: 'savings' })).body.id;

  // Every row has an unparseable amount, so nothing can be staged.
  const csv = 'Date,Description,Amount\n2026-06-10,FOO,notanumber\n2026-06-11,BAR,---';
  const imp = await client.post('/api/imports', { text: csv, account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 }, amountsNegativeAreExpense: true });
  assert.equal(imp.status, 201);
  assert.equal(imp.body.invalid, 2);

  const a = await getAccount(client, acct);
  assert.equal(a.last_import_status, 'failed');
  assert.match(a.last_import_error, /no valid rows/i);
});

test('import status: a no-header file flips a known account from staged to failed', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  // Establish a non-failed status first.
  await client.post('/api/imports', { text: 'Date,Description,Amount\n2026-06-10,COFFEE,-4.50', account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 } });
  assert.equal((await getAccount(client, acct)).last_import_status, 'staged');

  // A file with no usable header row (only blank lines) → 422, status flips to failed.
  const bad = await client.post('/api/imports', { text: '\n\n', account_id: acct, mapping: { date: 0, amount: 1 } });
  assert.equal(bad.status, 422);
  const a = await getAccount(client, acct);
  assert.equal(a.last_import_status, 'failed');
  assert.ok(a.last_import_error, 'a failure error message should be recorded');
});

test('import status: cross-book / malformed account never writes status', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acctB = (await b.client.post('/api/accounts', { name: 'B', type: 'checking' })).body.id;

  // A imports referencing B's account → 404, and the account keeps its null status.
  const cross = await a.client.post('/api/imports', { text: 'Date,Amount\n2026-06-10,-5', account_id: acctB, mapping: { date: 0, amount: 1 } });
  assert.equal(cross.status, 404);
  assert.equal((await getAccount(b.client, acctB)).last_import_status, null);

  // Malformed account id → 400 (nothing owned, nothing written).
  const malformed = await a.client.post('/api/imports', { text: 'Date,Amount\n2026-06-10,-5', account_id: 'nope', mapping: { date: 0, amount: 1 } });
  assert.equal(malformed.status, 400);
});

test('import status: confirming a row re-pointed to another account settles BOTH accounts', async () => {
  const { client } = await registerUser(base);
  const acctA = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const acctB = (await client.post('/api/accounts', { name: 'B', type: 'savings' })).body.id;

  // Single row imported into A.
  await client.post('/api/imports', { text: 'Date,Description,Amount\n2026-06-10,SHOP,-12.00', account_id: acctA, mapping: { date: 0, description: 1, merchant: 1, amount: 2 } });
  assert.equal((await getAccount(client, acctA)).last_import_status, 'staged');

  // Re-point the staged row to B, then confirm it.
  const staged = (await client.get('/api/imports/staged')).body;
  await client.put(`/api/imports/staged/${staged[0].id}`, { account_id: acctB, decision: 'import' });
  assert.equal((await client.post(`/api/imports/staged/${staged[0].id}/confirm`)).status, 201);

  // A is no longer stuck on 'staged'; B reflects the import.
  assert.notEqual((await getAccount(client, acctA)).last_import_status, 'staged');
  assert.equal((await getAccount(client, acctB)).last_import_status, 'imported');
});

test('import status: bulk confirm settles every affected account', async () => {
  const { client } = await registerUser(base);
  const acctA = (await client.post('/api/accounts', { name: 'A', type: 'checking' })).body.id;
  const acctB = (await client.post('/api/accounts', { name: 'B', type: 'savings' })).body.id;

  // Two rows imported into A; one is re-pointed to B before bulk confirm.
  await client.post('/api/imports', { text: 'Date,Description,Amount\n2026-06-01,X,-10.00\n2026-06-02,Y,-20.00', account_id: acctA, mapping: { date: 0, description: 1, merchant: 1, amount: 2 } });
  const staged = (await client.get('/api/imports/staged')).body;
  await client.put(`/api/imports/staged/${staged[0].id}`, { account_id: acctB, decision: 'import' });

  const bulk = await client.post('/api/imports/staged/confirm', {});
  assert.equal(bulk.body.imported, 2);
  assert.notEqual((await getAccount(client, acctA)).last_import_status, 'staged');
  assert.equal((await getAccount(client, acctB)).last_import_status, 'imported');
});

test('editing a staged row with a partial payload preserves omitted fields', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const cat = (await client.post('/api/categories', { name: 'Food', kind: 'expense' })).body.id;

  // Stage one row, then enrich it (account, category, merchant, description all set).
  await client.post('/api/imports', { text: 'Date,Description,Amount\n2026-06-10,SHOP RUN,-12.00', account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 } });
  let staged = (await client.get('/api/imports/staged')).body;
  const id = staged[0].id;
  await client.put(`/api/imports/staged/${id}`, { account_id: acct, category_id: cat, merchant: 'Shop Run', description: 'groceries', decision: 'import' });
  staged = (await client.get('/api/imports/staged')).body;
  let row = staged.find((s: any) => s.id === id);
  assert.equal(row.category_id, cat);
  assert.equal(row.merchant, 'Shop Run');
  assert.equal(row.description, 'groceries');

  // Toggle ONLY decision -> every other field must survive.
  await client.put(`/api/imports/staged/${id}`, { decision: 'skip' });
  row = (await client.get('/api/imports/staged')).body.find((s: any) => s.id === id);
  assert.equal(row.decision, 'skip');
  assert.equal(row.account_id, acct, 'account preserved when omitted');
  assert.equal(row.category_id, cat, 'category preserved when omitted');
  assert.equal(row.merchant, 'Shop Run', 'merchant preserved when omitted');
  assert.equal(row.description, 'groceries', 'description preserved when omitted');

  // An explicit null still clears (intentional clearing remains possible).
  await client.put(`/api/imports/staged/${id}`, { category_id: null });
  row = (await client.get('/api/imports/staged')).body.find((s: any) => s.id === id);
  assert.equal(row.category_id, null, 'explicit null clears the field');
  assert.equal(row.merchant, 'Shop Run', 'unrelated fields still preserved');
});

test('import dedup: same amount/date, different merchant is staged for review (not skipped)', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card' })).body.id;
  // An existing Target charge to dedup against.
  await client.post('/api/transactions', { amount: 124, account_id: acct, direction: 'expense', merchant: 'Target', txn_date: '2026-06-06', posted_date: '2026-06-06' });

  const csv = 'Date,Description,Amount\n2026-06-06,TARGET STORE #1,-124.00\n2026-06-06,WALMART SUPERCENTER,-124.00';
  const imp = await client.post('/api/imports', { text: csv, account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 }, amountsNegativeAreExpense: true });
  assert.equal(imp.status, 201);

  const staged = (await client.get('/api/imports/staged')).body;
  const target = staged.find((s: any) => (s.merchant || '').toLowerCase().includes('target'));
  const walmart = staged.find((s: any) => (s.merchant || '').toLowerCase().includes('walmart'));
  // Same merchant -> skipped as a duplicate of the existing transaction.
  assert.equal(target.decision, 'skip');
  assert.equal(target.skip_reason, 'matches_existing');
  // Different merchant at the same amount/date -> staged for the user to decide.
  assert.equal(walmart.decision, 'import');
});

test('bulk confirm (set-based insert) posts staged rows with correct fields', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const csv = 'Date,Description,Amount\n2026-03-15,COFFEE,-4.50\n2026-03-16,PAYCHECK,2000.00';
  await client.post('/api/imports', { text: csv, account_id: acct, mapping: { date: 0, description: 1, merchant: 1, amount: 2 }, amountsNegativeAreExpense: true });

  const bulk = await client.post('/api/imports/staged/confirm', {});
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.imported, 2);

  // The chunked multi-row INSERT must map every column correctly and post the rows.
  const txns = (await client.get(`/api/transactions?account_id=${acct}`)).body;
  const all = [...txns.posted, ...txns.pending];
  assert.equal(all.length, 2);
  const coffee = all.find((t: any) => t.merchant === 'Coffee');
  const pay = all.find((t: any) => t.merchant === 'Paycheck');
  assert.ok(coffee && pay, 'both rows posted with cleaned merchant names');
  assert.equal(Number(coffee.amount), 4.5);
  assert.equal(coffee.direction, 'expense');
  assert.ok(coffee.posted_date, 'a confirmed row is posted, not pending');
  assert.equal(String(coffee.txn_date).slice(0, 10), '2026-03-15');
  assert.equal(Number(pay.amount), 2000);
  assert.equal(pay.direction, 'income');
  // No staged rows remain after confirm.
  assert.equal((await client.get('/api/imports/staged')).body.length, 0);
});
