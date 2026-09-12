import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const PDF = 'aGVsbG8=';

// Property value contribution to net worth (0 if the group is absent/filtered out).
function propertyAssets(networth: any): number {
  const g = networth.assetGroups.find((x: any) => x.type === 'property');
  return g ? Number(g.total) : 0;
}

test('property CRUD: create with full detail, list (computed cols), update, delete', async () => {
  const { client } = await registerUser(base);

  const created = await client.post('/api/properties', {
    name: 'Main House', address: '123 Main St', city: 'Austin', state: 'TX', zip: '78701',
    property_type: 'single_family', purchase_date: '2020-01-01', purchase_price: 300000,
    current_value: 400000, mortgage_balance: 200000, year_built: 1999, square_feet: 2000,
    lot_size_acres: 0.25, bedrooms: 3, bathrooms: 2, stories: 2, garage_spaces: 2,
    is_rental: false, is_new_construction: false, property_tax_annual: 6000, hoa_dues: 50, hoa_cycle: 'monthly',
  });
  assert.equal(created.status, 201);
  const p = created.body;
  assert.equal(p.name, 'Main House');
  assert.equal(Number(p.current_value), 400000);
  assert.equal(Number(p.lot_size_acres), 0.25);

  // Default property_type is single_family.
  const bare = (await client.post('/api/properties', { name: 'Cabin' })).body;
  assert.equal(bare.property_type, 'single_family');

  // List carries computed columns (total_spent, txn_count, doc_count).
  const list = (await client.get('/api/properties')).body;
  const row = list.find((x: any) => x.id === p.id);
  assert.ok(row);
  assert.equal(Number(row.total_spent), 0);
  assert.equal(Number(row.txn_count), 0);
  assert.equal(Number(row.doc_count), 0);

  const upd = await client.put(`/api/properties/${p.id}`, { name: 'Main Home', current_value: 420000, is_rental: true });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Main Home');
  assert.equal(Number(upd.body.current_value), 420000);
  assert.equal(upd.body.is_rental, true);

  assert.equal((await client.del(`/api/properties/${p.id}`)).status, 204);
  assert.ok(!(await client.get('/api/properties')).body.some((x: any) => x.id === p.id));
});

test('property validation errors → 400 / 404', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/properties', {})).status, 400);            // missing name
  assert.equal((await client.post('/api/properties', { name: ' ' })).status, 400);  // blank name
  assert.equal((await client.post('/api/properties', { name: 'X', property_type: 'castle' })).status, 400);
  assert.equal((await client.post('/api/properties', { name: 'X', current_value: 1.001 })).status, 400);
  assert.equal((await client.post('/api/properties', { name: 'X', is_rental: 'maybe' })).status, 400);
  assert.equal((await client.post('/api/properties', { name: 'X', purchase_date: 'nope' })).status, 400);

  const id = (await client.post('/api/properties', { name: 'Ok' })).body.id;
  assert.equal((await client.put(`/api/properties/${id}`, { property_type: 'nope' })).status, 400);
  assert.equal((await client.put('/api/properties/999999', { name: 'z' })).status, 404);
});

test('property reorder persists sort_order', async () => {
  const { client } = await registerUser(base);
  const a = (await client.post('/api/properties', { name: 'A' })).body.id;
  const b = (await client.post('/api/properties', { name: 'B' })).body.id;
  const c = (await client.post('/api/properties', { name: 'C' })).body.id;

  // Reorder to C, A, B (also tolerates garbage ids being filtered out).
  const r = await client.post('/api/properties/reorder', { ids: [c, a, b, 'garbage', NaN] });
  assert.equal(r.status, 200);
  const ordered = (await client.get('/api/properties')).body.map((x: any) => x.id);
  assert.deepEqual(ordered.slice(0, 3), [c, a, b]);

  // Empty/absent ids body is a no-op that still succeeds.
  assert.equal((await client.post('/api/properties/reorder', {})).status, 200);
});

test('property dispose/restore drops and re-adds it from net worth', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'Rental', current_value: 350000 })).body;

  assert.equal(propertyAssets((await client.get('/api/networth')).body), 350000);

  const disp = await client.post(`/api/properties/${prop.id}/dispose`, {
    disposed: true, disposal_type: 'sold', disposed_at: '2026-06-01', disposal_amount: 360000, disposal_note: 'sold',
  });
  assert.equal(disp.status, 200);
  assert.equal(disp.body.disposal_type, 'sold');
  assert.equal(disp.body.disposed_at.slice(0, 10), '2026-06-01');
  assert.equal(Number(disp.body.disposal_amount), 360000);
  assert.equal(propertyAssets((await client.get('/api/networth')).body), 0);

  // Invalid disposal_type → 400.
  assert.equal((await client.post(`/api/properties/${prop.id}/dispose`, { disposed: true, disposal_type: 'vaporized' })).status, 400);
  // Bad disposed value → 400.
  assert.equal((await client.post(`/api/properties/${prop.id}/dispose`, { disposed: 'maybe' })).status, 400);
  // Dispose a missing property → 404.
  assert.equal((await client.post('/api/properties/999999/dispose', { disposed: true })).status, 404);

  // Restore clears disposal fields and re-adds to net worth.
  const restored = await client.post(`/api/properties/${prop.id}/dispose`, { disposed: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.disposed_at, null);
  assert.equal(restored.body.disposal_type, null);
  assert.equal(propertyAssets((await client.get('/api/networth')).body), 350000);
});

test('property value snapshots drive current value; delete re-syncs', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'Home', current_value: 400000 })).body;

  // value required.
  assert.equal((await client.post(`/api/properties/${prop.id}/values`, {})).status, 400);
  // Bad value / date → 400.
  assert.equal((await client.post(`/api/properties/${prop.id}/values`, { value: 1.001 })).status, 400);
  assert.equal((await client.post(`/api/properties/${prop.id}/values`, { value: 100, as_of: 'nope' })).status, 400);

  const v1 = await client.post(`/api/properties/${prop.id}/values`, { value: 410000, as_of: '2026-01-01' });
  assert.equal(v1.status, 201);
  assert.equal(Number(v1.body.value), 410000);
  assert.equal((await client.post(`/api/properties/${prop.id}/values`, { value: 430000, as_of: '2026-06-01' })).status, 201);

  const vals = (await client.get(`/api/properties/${prop.id}/values`)).body;
  assert.equal(vals.length, 2);
  assert.equal(propertyAssets((await client.get('/api/networth')).body), 430000);

  const latest = vals.find((r: any) => r.as_of === '2026-06-01');
  assert.equal((await client.del(`/api/properties/${prop.id}/values/${latest.id}`)).status, 204);
  assert.equal(propertyAssets((await client.get('/api/networth')).body), 410000);
});

test('property maintenance with transaction link, expense-candidates, and summary rollup', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const prop = (await client.post('/api/properties', {
    name: 'Rental', purchase_date: '2024-01-01', purchase_price: 300000, current_value: 360000,
    mortgage_balance: 200000, rental_income: 2000,
  })).body;

  // A property-tagged expense (this is the spend the summary rolls up).
  await client.post('/api/transactions', {
    amount: 500, account_id: acct, direction: 'expense', txn_date: '2026-05-01',
    tags: [{ kind: 'property', ref_id: prop.id }],
  });
  // A property-tagged income (rent).
  await client.post('/api/transactions', {
    amount: 2000, account_id: acct, direction: 'income', txn_date: '2026-05-05',
    tags: [{ kind: 'property', ref_id: prop.id }],
  });

  // Expense candidates: the tagged expense shows up.
  const cands = (await client.get(`/api/properties/${prop.id}/expense-candidates`)).body;
  assert.equal(cands.length, 1);
  const txnId = cands[0].id;

  // item required.
  assert.equal((await client.post(`/api/properties/${prop.id}/maintenance`, {})).status, 400);
  // Bad status enum → 400.
  assert.equal((await client.post(`/api/properties/${prop.id}/maintenance`, { item: 'X', status: 'pending' })).status, 400);
  // Cross-book / bad transaction link → 404.
  assert.equal((await client.post(`/api/properties/${prop.id}/maintenance`, { item: 'X', transaction_id: 999999 })).status, 404);

  const m = await client.post(`/api/properties/${prop.id}/maintenance`, {
    item: 'Roof repair', status: 'completed', service_date: '2026-05-01', cost: 500,
    transaction_id: txnId, vendor: 'RoofCo', notes: 'shingles',
  });
  assert.equal(m.status, 201);

  const up = await client.post(`/api/properties/${prop.id}/maintenance`, { item: 'HVAC service', status: 'upcoming', due_date: '2026-12-01' });
  assert.equal(up.status, 201);

  const list = (await client.get(`/api/properties/${prop.id}/maintenance`)).body;
  assert.equal(list.length, 2);
  const roof = list.find((x: any) => x.item === 'Roof repair');
  assert.equal(roof.transaction_id, txnId);
  assert.equal(Number(roof.txn_amount), 500); // joined transaction amount

  // Edit + edit-missing (404) + delete.
  const edited = await client.put(`/api/properties/${prop.id}/maintenance/${m.body.id}`, { item: 'Roof + gutters', status: 'completed', cost: 550 });
  assert.equal(edited.status, 200);
  assert.equal((await client.put(`/api/properties/${prop.id}/maintenance/999999`, { item: 'z' })).status, 404);
  assert.equal((await client.del(`/api/properties/${prop.id}/maintenance/${m.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/properties/${prop.id}/maintenance`)).body.length, 1);

  // Summary exercises propertySummary(): equity, appreciation, yields, months owned.
  const summary = (await client.get(`/api/properties/${prop.id}/summary`)).body;
  assert.equal(summary.property.id, prop.id);
  assert.equal(Number(summary.totalSpent), 500);
  assert.equal(Number(summary.totalIncome), 2000);
  assert.equal(Number(summary.net), 1500);
  assert.equal(Number(summary.equity), 160000);          // 360000 - 200000
  assert.equal(Number(summary.appreciation), 60000);     // 360000 - 300000
  assert.equal(Number(summary.annualRentalIncome), 24000); // 2000 * 12
  assert.ok(summary.monthsOwned > 0);
  assert.ok(summary.costPerMonth != null);
  assert.ok(summary.grossYield != null);
  assert.ok(summary.byCategory.length >= 1);

  // Summary for a missing property → 404.
  assert.equal((await client.get('/api/properties/999999/summary')).status, 404);
});

test('property summary with no purchase/value data yields null-derived fields', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'Bare lot' })).body;
  const summary = (await client.get(`/api/properties/${prop.id}/summary`)).body;
  assert.equal(summary.monthsOwned, null);
  assert.equal(summary.costPerMonth, null);
  assert.equal(summary.equity, null);
  assert.equal(summary.appreciation, null);
  assert.equal(summary.annualRentalIncome, null);
  assert.equal(summary.grossYield, null);
  assert.equal(Number(summary.totalSpent), 0);
});

test('property mortgage-account: create, idempotent reuse, list join, unlink', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'House', mortgage_balance: 250000 })).body;

  // Create the managed mortgage account (opening_balance falls back to mortgage_balance).
  const acct = await client.post(`/api/properties/${prop.id}/mortgage-account`, {});
  assert.equal(acct.status, 201);
  assert.equal(acct.body.is_liability, true);
  assert.equal(acct.body.type, 'mortgage');

  // The list join surfaces the mortgage account name/balance.
  const row = (await client.get('/api/properties')).body.find((x: any) => x.id === prop.id);
  assert.equal(row.mortgage_account_name, acct.body.name);

  // Calling again returns the SAME existing account (idempotent).
  const again = await client.post(`/api/properties/${prop.id}/mortgage-account`, { opening_balance: 100000 });
  assert.equal(again.status, 201);
  assert.equal(again.body.id, acct.body.id);

  // Bad opening_balance (negative) → 400 on a property with no existing account.
  const prop2 = (await client.post('/api/properties', { name: 'H2' })).body;
  assert.equal((await client.post(`/api/properties/${prop2.id}/mortgage-account`, { opening_balance: -5 })).status, 400);

  // Missing property → 404.
  assert.equal((await client.post('/api/properties/999999/mortgage-account', {})).status, 404);

  // Unlink leaves the account, clears the link.
  assert.equal((await client.del(`/api/properties/${prop.id}/mortgage-account`)).status, 204);
  assert.equal((await client.get('/api/properties')).body.find((x: any) => x.id === prop.id).mortgage_account_id, null);
});

test('property documents: MIME validation, list, serve, update, delete', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'House' })).body;

  assert.equal((await client.post(`/api/properties/${prop.id}/documents`, {})).status, 400);
  assert.equal((await client.post(`/api/properties/${prop.id}/documents`, { file: 7, file_mime: 'application/pdf' })).status, 400);
  assert.equal((await client.post(`/api/properties/${prop.id}/documents`, { file: PDF, file_mime: 'text/html' })).status, 400);

  const up = await client.post(`/api/properties/${prop.id}/documents`, { file: PDF, file_mime: 'application/pdf', file_name: 'deed.pdf', doc_type: 'deed' });
  assert.equal(up.status, 201);
  assert.equal(up.body.doc_type, 'deed');

  assert.equal((await client.get(`/api/properties/${prop.id}/documents`)).body.length, 1);
  // doc_count reflected in the list.
  assert.equal(Number((await client.get('/api/properties')).body.find((x: any) => x.id === prop.id).doc_count), 1);

  const file = await fetch(`${base}/api/properties/${prop.id}/documents/${up.body.id}/file`, { headers: { cookie: client.cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  const meta = await client.put(`/api/properties/${prop.id}/documents/${up.body.id}`, { name: 'Deed v2' });
  assert.equal(meta.status, 200);
  assert.equal(meta.body.name, 'Deed v2');
  assert.equal(meta.body.doc_type, 'other');

  assert.equal((await client.put(`/api/properties/${prop.id}/documents/${up.body.id}`, { file: PDF, file_mime: 'text/html' })).status, 400);
  assert.equal((await client.put(`/api/properties/${prop.id}/documents/${up.body.id}`, { file: 5 })).status, 400);
  const withFile = await client.put(`/api/properties/${prop.id}/documents/${up.body.id}`, { name: 'V3', file: PDF, file_mime: 'application/pdf', file_name: 'v3.pdf' });
  assert.equal(withFile.status, 200);
  assert.equal(withFile.body.file_name, 'v3.pdf');

  assert.equal((await client.put(`/api/properties/${prop.id}/documents/999999`, { name: 'z' })).status, 404);
  const missing = await fetch(`${base}/api/properties/${prop.id}/documents/999999/file`, { headers: { cookie: client.cookie } });
  assert.equal(missing.status, 404);

  assert.equal((await client.del(`/api/properties/${prop.id}/documents/${up.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/properties/${prop.id}/documents`)).body.length, 0);
});

test('estimate-value: 400 when unidentifiable, and the estimate path is reached', async () => {
  const { client } = await registerUser(base);
  // No address, size, or purchase price → 400 before any RentCast/AI call.
  const noData = await client.post('/api/properties/estimate-value', { property_type: 'single_family' });
  assert.equal(noData.status, 400);

  // Bad square_feet → 400 (validated before use).
  assert.equal((await client.post('/api/properties/estimate-value', { square_feet: 1.001, address: '1 A St' })).status, 400);
  assert.equal((await client.post('/api/properties/estimate-value', { lot_size_acres: 'nope', address: '1 A St' })).status, 400);

  // No address but a purchase price → passes the 400 gate and SKIPS RentCast (which
  // needs an address), taking the AI appraisal path. The exact outcome depends on
  // whether/how AI is configured on the host (503 unconfigured, 200 with a value, or
  // a 5xx upstream error). We assert only that the branch is REACHED (not a 400).
  const aiPath = await client.post('/api/properties/estimate-value', {
    property_type: 'single_family', square_feet: 2000, lot_size_acres: 0.25,
    year_built: 1999, purchase_price: 300000, purchase_date: '2020-01-01',
  });
  assert.notEqual(aiPath.status, 400);

  // With an address the estimate path is still reached (RentCast when a key is set,
  // else the AI path). Either way it does NOT 400 — a value or an upstream error.
  const withAddress = await client.post('/api/properties/estimate-value', {
    address: '123 Main St', city: 'Austin', state: 'TX', zip: '78701', property_type: 'single_family',
  });
  assert.notEqual(withAddress.status, 400);
});

test('cross-book isolation for property endpoints', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const propA = (await a.client.post('/api/properties', { name: 'A' })).body.id;

  assert.equal((await b.client.put(`/api/properties/${propA}`, { name: 'x' })).status, 404);
  assert.equal((await b.client.post(`/api/properties/${propA}/dispose`, { disposed: true })).status, 404);
  assert.equal((await b.client.get(`/api/properties/${propA}/values`)).status, 404);
  assert.equal((await b.client.post(`/api/properties/${propA}/values`, { value: 100 })).status, 404);
  assert.equal((await b.client.get(`/api/properties/${propA}/maintenance`)).status, 404);
  assert.equal((await b.client.post(`/api/properties/${propA}/maintenance`, { item: 'x' })).status, 404);
  assert.equal((await b.client.get(`/api/properties/${propA}/expense-candidates`)).status, 404);
  assert.equal((await b.client.get(`/api/properties/${propA}/documents`)).status, 404);
  assert.equal((await b.client.get(`/api/properties/${propA}/summary`)).status, 404);
  assert.equal((await b.client.post(`/api/properties/${propA}/mortgage-account`, {})).status, 404);
  assert.equal((await b.client.get(`/api/properties/${propA}/insurance`)).status, 404);
});
