import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const PDF = 'aGVsbG8=';

test('liability CRUD: create → list → update → delete', async () => {
  const { client } = await registerUser(base);

  const created = await client.post('/api/liabilities', {
    name: 'Home loan', liability_type: 'mortgage', balance: 250000, original_amount: 300000,
    interest_rate: 3.125, minimum_payment: 1500, due_day: 1, lender: 'Bank', account_number: 'X-9',
    opened_date: '2020-01-01', payoff_date: '2050-01-01', notes: 'primary', tracks_balance: true,
  });
  assert.equal(created.status, 201);
  const l = created.body;
  assert.equal(l.name, 'Home loan');
  assert.equal(l.liability_type, 'mortgage');
  assert.equal(Number(l.balance), 250000);
  assert.equal(Number(l.interest_rate), 3.125); // rate allows 3 decimals
  assert.equal(l.due_day, 1);
  assert.equal(l.tracks_balance, true);

  // Default liability_type is 'mortgage'.
  const bare = (await client.post('/api/liabilities', { name: 'Card' })).body;
  assert.equal(bare.liability_type, 'mortgage');

  const list = (await client.get('/api/liabilities')).body;
  assert.ok(list.some((x: any) => x.id === l.id));

  const upd = await client.put(`/api/liabilities/${l.id}`, {
    name: 'Home loan (refi)', balance: 240000, interest_rate: 2.75, tracks_balance: false,
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Home loan (refi)');
  assert.equal(Number(upd.body.balance), 240000);
  assert.equal(Number(upd.body.interest_rate), 2.75);
  assert.equal(upd.body.tracks_balance, false);

  assert.equal((await client.del(`/api/liabilities/${l.id}`)).status, 204);
  assert.ok(!(await client.get('/api/liabilities')).body.some((x: any) => x.id === l.id));
});

test('liability validation errors → 400 / 404', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/liabilities', {})).status, 400);              // missing name
  assert.equal((await client.post('/api/liabilities', { name: '  ' })).status, 400);   // blank name
  assert.equal((await client.post('/api/liabilities', { name: 'X', liability_type: 'bogus' })).status, 400);
  assert.equal((await client.post('/api/liabilities', { name: 'X', balance: 1.005 })).status, 400);      // sub-cent
  assert.equal((await client.post('/api/liabilities', { name: 'X', interest_rate: 'abc' })).status, 400); // not a number
  assert.equal((await client.post('/api/liabilities', { name: 'X', due_day: 1.5 })).status, 400);        // not an int id
  assert.equal((await client.post('/api/liabilities', { name: 'X', opened_date: 'nope' })).status, 400);
  assert.equal((await client.post('/api/liabilities', { name: 'X', minimum_payment: 0.001 })).status, 400);

  const id = (await client.post('/api/liabilities', { name: 'Ok' })).body.id;
  assert.equal((await client.put(`/api/liabilities/${id}`, { liability_type: 'nope' })).status, 400);
  assert.equal((await client.put('/api/liabilities/999999', { name: 'z' })).status, 404);
});

test('liability balance snapshots drive current balance; delete re-syncs', async () => {
  const { client } = await registerUser(base);
  const liab = (await client.post('/api/liabilities', { name: 'Auto loan', liability_type: 'auto_loan', balance: 20000 })).body;

  // value required.
  assert.equal((await client.post(`/api/liabilities/${liab.id}/balances`, {})).status, 400);

  assert.equal((await client.post(`/api/liabilities/${liab.id}/balances`, { value: 18000, as_of: '2026-01-01' })).status, 201);
  assert.equal((await client.post(`/api/liabilities/${liab.id}/balances`, { value: 16000, as_of: '2026-06-01' })).status, 201);

  const bals = (await client.get(`/api/liabilities/${liab.id}/balances`)).body;
  assert.equal(bals.length, 2);
  // Returned as {as_of, value} (aliasing balance) so it reuses the snapshot UI.
  assert.equal(Number(bals.find((r: any) => r.as_of === '2026-06-01').value), 16000);

  // Latest-dated snapshot anchors current balance.
  assert.equal(Number((await client.get('/api/liabilities')).body.find((x: any) => x.id === liab.id).balance), 16000);

  // Upsert on same date.
  assert.equal((await client.post(`/api/liabilities/${liab.id}/balances`, { value: 15500, as_of: '2026-06-01' })).status, 201);
  assert.equal((await client.get(`/api/liabilities/${liab.id}/balances`)).body.length, 2);

  // Deleting the latest re-syncs down.
  const latest = (await client.get(`/api/liabilities/${liab.id}/balances`)).body.find((r: any) => r.as_of === '2026-06-01');
  assert.equal((await client.del(`/api/liabilities/${liab.id}/balances/${latest.id}`)).status, 204);
  assert.equal(Number((await client.get('/api/liabilities')).body.find((x: any) => x.id === liab.id).balance), 18000);
});

test('liability documents: MIME validation, list, serve, update, delete', async () => {
  const { client } = await registerUser(base);
  const liab = (await client.post('/api/liabilities', { name: 'Student loan', liability_type: 'student_loan' })).body;

  // file required + type checks.
  assert.equal((await client.post(`/api/liabilities/${liab.id}/documents`, {})).status, 400);
  assert.equal((await client.post(`/api/liabilities/${liab.id}/documents`, { file: 42, file_mime: 'application/pdf' })).status, 400);
  assert.equal((await client.post(`/api/liabilities/${liab.id}/documents`, { file: PDF, file_mime: 'image/svg+xml' })).status, 400);

  const up = await client.post(`/api/liabilities/${liab.id}/documents`, {
    file: PDF, file_mime: 'application/pdf', file_name: 'statement.pdf', doc_type: 'statement',
  });
  assert.equal(up.status, 201);
  assert.equal(up.body.doc_type, 'statement');

  assert.equal((await client.get(`/api/liabilities/${liab.id}/documents`)).body.length, 1);

  const file = await fetch(`${base}/api/liabilities/${liab.id}/documents/${up.body.id}/file`, { headers: { cookie: client.cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  // Metadata-only update.
  const meta = await client.put(`/api/liabilities/${liab.id}/documents/${up.body.id}`, { name: 'Renamed' });
  assert.equal(meta.status, 200);
  assert.equal(meta.body.name, 'Renamed');
  assert.equal(meta.body.doc_type, 'other');

  // File-replacement update (bad type → 400, then good).
  assert.equal((await client.put(`/api/liabilities/${liab.id}/documents/${up.body.id}`, { file: PDF, file_mime: 'text/html' })).status, 400);
  assert.equal((await client.put(`/api/liabilities/${liab.id}/documents/${up.body.id}`, { file: 9 })).status, 400);
  const withFile = await client.put(`/api/liabilities/${liab.id}/documents/${up.body.id}`, { name: 'V2', file: PDF, file_mime: 'application/pdf', file_name: 'v2.pdf' });
  assert.equal(withFile.status, 200);
  assert.equal(withFile.body.file_name, 'v2.pdf');

  // Missing document update / serve → 404.
  assert.equal((await client.put(`/api/liabilities/${liab.id}/documents/999999`, { name: 'z' })).status, 404);
  const missing = await fetch(`${base}/api/liabilities/${liab.id}/documents/999999/file`, { headers: { cookie: client.cookie } });
  assert.equal(missing.status, 404);

  assert.equal((await client.del(`/api/liabilities/${liab.id}/documents/${up.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/liabilities/${liab.id}/documents`)).body.length, 0);
});

test('cross-book isolation for liability endpoints', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const liabA = (await a.client.post('/api/liabilities', { name: 'A' })).body.id;

  assert.equal((await b.client.put(`/api/liabilities/${liabA}`, { name: 'x' })).status, 404);
  assert.equal((await b.client.get(`/api/liabilities/${liabA}/balances`)).status, 404);
  assert.equal((await b.client.post(`/api/liabilities/${liabA}/balances`, { value: 100 })).status, 404);
  assert.equal((await b.client.get(`/api/liabilities/${liabA}/documents`)).status, 404);
  assert.equal((await b.client.post(`/api/liabilities/${liabA}/documents`, { file: PDF, file_mime: 'application/pdf' })).status, 404);
});
