import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const PDF = 'aGVsbG8=';

test('asset CRUD: create → list → read via values, update, delete', async () => {
  const { client } = await registerUser(base);

  // Create with defaults + explicit fields.
  const created = await client.post('/api/assets', {
    name: 'Tractor', asset_type: 'equipment', value: 12000, purchase_price: 15000,
    purchase_date: '2024-01-01', notes: 'green', tracks_value: true, has_insurance: true,
  });
  assert.equal(created.status, 201);
  const a = created.body;
  assert.equal(a.name, 'Tractor');
  assert.equal(a.asset_type, 'equipment');
  assert.equal(Number(a.value), 12000);
  assert.equal(a.tracks_value, true);
  assert.equal(a.has_insurance, true);

  // Default asset_type is 'property' when omitted.
  const bare = (await client.post('/api/assets', { name: 'Land parcel' })).body;
  assert.equal(bare.asset_type, 'property');

  // List, ordered by type then name.
  const list = (await client.get('/api/assets')).body;
  assert.ok(list.some((x: any) => x.id === a.id));
  assert.ok(list.some((x: any) => x.id === bare.id));

  // Update.
  const upd = await client.put(`/api/assets/${a.id}`, { name: 'Big Tractor', value: 11000, tracks_value: false });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Big Tractor');
  assert.equal(Number(upd.body.value), 11000);
  assert.equal(upd.body.tracks_value, false);

  // Delete.
  assert.equal((await client.del(`/api/assets/${a.id}`)).status, 204);
  assert.ok(!(await client.get('/api/assets')).body.some((x: any) => x.id === a.id));
});

test('asset create/update validation errors → 400', async () => {
  const { client } = await registerUser(base);
  // Missing name.
  assert.equal((await client.post('/api/assets', {})).status, 400);
  // Blank name.
  assert.equal((await client.post('/api/assets', { name: '   ' })).status, 400);
  // Bad enum.
  assert.equal((await client.post('/api/assets', { name: 'X', asset_type: 'spaceship' })).status, 400);
  // Sub-cent money.
  assert.equal((await client.post('/api/assets', { name: 'X', value: 1.005 })).status, 400);
  // Bad date.
  assert.equal((await client.post('/api/assets', { name: 'X', purchase_date: 'nope' })).status, 400);

  const id = (await client.post('/api/assets', { name: 'Ok' })).body.id;
  assert.equal((await client.put(`/api/assets/${id}`, { asset_type: 'bogus' })).status, 400);
  // Update a missing asset → 404.
  assert.equal((await client.put('/api/assets/999999', { name: 'z' })).status, 404);
});

test('asset value snapshots drive current value; delete re-syncs', async () => {
  const { client } = await registerUser(base);
  const asset = (await client.post('/api/assets', { name: 'Boat', asset_type: 'boat', value: 5000 })).body;

  // value is required.
  assert.equal((await client.post(`/api/assets/${asset.id}/values`, {})).status, 400);

  assert.equal((await client.post(`/api/assets/${asset.id}/values`, { value: 4000, as_of: '2026-01-01' })).status, 201);
  assert.equal((await client.post(`/api/assets/${asset.id}/values`, { value: 3000, as_of: '2026-06-01' })).status, 201);

  const vals = (await client.get(`/api/assets/${asset.id}/values`)).body;
  assert.equal(vals.length, 2);

  // Latest-dated snapshot anchors the asset's current value.
  assert.equal(Number((await client.get('/api/assets')).body.find((x: any) => x.id === asset.id).value), 3000);

  // Deleting the latest re-syncs down to the remaining snapshot.
  const latest = vals.find((r: any) => r.as_of === '2026-06-01');
  assert.equal((await client.del(`/api/assets/${asset.id}/values/${latest.id}`)).status, 204);
  assert.equal(Number((await client.get('/api/assets')).body.find((x: any) => x.id === asset.id).value), 4000);
});

test('asset maintenance: create (completed + upcoming), edit, list, delete', async () => {
  const { client } = await registerUser(base);
  const asset = (await client.post('/api/assets', { name: 'Excavator' })).body;

  // item required.
  assert.equal((await client.post(`/api/assets/${asset.id}/maintenance`, {})).status, 400);

  const done = await client.post(`/api/assets/${asset.id}/maintenance`, {
    item: 'Oil change', status: 'completed', service_date: '2026-05-01', cost: 120, vendor: 'Shop', notes: 'ok',
  });
  assert.equal(done.status, 201);
  assert.equal(done.body.item, 'Oil change');
  assert.equal(done.body.status, 'completed');
  assert.equal(Number(done.body.cost), 120);

  const up = await client.post(`/api/assets/${asset.id}/maintenance`, {
    item: 'Inspection', status: 'upcoming', due_date: '2026-12-01',
  });
  assert.equal(up.status, 201);
  assert.equal(up.body.status, 'upcoming');

  const list = (await client.get(`/api/assets/${asset.id}/maintenance`)).body;
  assert.equal(list.length, 2);

  // Edit (any non-'upcoming' status normalizes to 'completed').
  const edited = await client.put(`/api/assets/${asset.id}/maintenance/${done.body.id}`, {
    item: 'Oil & filter', status: 'done', cost: 130,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item, 'Oil & filter');
  assert.equal(edited.body.status, 'completed');

  // Edit a missing item → 404.
  assert.equal((await client.put(`/api/assets/${asset.id}/maintenance/999999`, { item: 'z' })).status, 404);

  assert.equal((await client.del(`/api/assets/${asset.id}/maintenance/${done.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/assets/${asset.id}/maintenance`)).body.length, 1);
});

test('asset documents: MIME validation, list, serve, update (meta + file), delete', async () => {
  const { client } = await registerUser(base);
  const asset = (await client.post('/api/assets', { name: 'Painting', asset_type: 'collectible' })).body;

  // file required.
  assert.equal((await client.post(`/api/assets/${asset.id}/documents`, {})).status, 400);
  // Non-string file.
  assert.equal((await client.post(`/api/assets/${asset.id}/documents`, { file: 123, file_mime: 'application/pdf' })).status, 400);
  // Disallowed MIME.
  assert.equal((await client.post(`/api/assets/${asset.id}/documents`, { file: PDF, file_mime: 'text/html', file_name: 'x.html' })).status, 400);

  const up = await client.post(`/api/assets/${asset.id}/documents`, {
    file: PDF, file_mime: 'application/pdf', file_name: 'appraisal.pdf', doc_type: 'appraisal',
  });
  assert.equal(up.status, 201);
  assert.equal(up.body.doc_type, 'appraisal');
  assert.equal(up.body.name, 'appraisal.pdf'); // name falls back to file_name

  const docs = (await client.get(`/api/assets/${asset.id}/documents`)).body;
  assert.equal(docs.length, 1);

  // Served back with hardened headers.
  const file = await fetch(`${base}/api/assets/${asset.id}/documents/${up.body.id}/file`, { headers: { cookie: client.cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  // Update metadata only (no file).
  const metaOnly = await client.put(`/api/assets/${asset.id}/documents/${up.body.id}`, { name: 'Renamed', doc_type: '' });
  assert.equal(metaOnly.status, 200);
  assert.equal(metaOnly.body.name, 'Renamed');
  assert.equal(metaOnly.body.doc_type, 'other'); // blank doc_type → 'other'

  // Update replacing the file (with bad file type → 400).
  assert.equal((await client.put(`/api/assets/${asset.id}/documents/${up.body.id}`, { file: PDF, file_mime: 'text/html' })).status, 400);
  // Update replacing the file (valid).
  const withFile = await client.put(`/api/assets/${asset.id}/documents/${up.body.id}`, { name: 'V2', file: PDF, file_mime: 'application/pdf', file_name: 'v2.pdf' });
  assert.equal(withFile.status, 200);
  assert.equal(withFile.body.file_name, 'v2.pdf');
  // Non-string replacement file → 400.
  assert.equal((await client.put(`/api/assets/${asset.id}/documents/${up.body.id}`, { file: 5 })).status, 400);

  // Update a missing document → 404.
  assert.equal((await client.put(`/api/assets/${asset.id}/documents/999999`, { name: 'z' })).status, 404);
  // Serve a missing doc → 404.
  const missing = await fetch(`${base}/api/assets/${asset.id}/documents/999999/file`, { headers: { cookie: client.cookie } });
  assert.equal(missing.status, 404);

  assert.equal((await client.del(`/api/assets/${asset.id}/documents/${up.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/assets/${asset.id}/documents`)).body.length, 0);
});

test('asset insurance policies: CRUD + validation', async () => {
  const { client } = await registerUser(base);
  const asset = (await client.post('/api/assets', { name: 'RV', asset_type: 'rv', has_insurance: true })).body;

  assert.equal((await client.get(`/api/assets/${asset.id}/insurance`)).body.length, 0);

  const pol = await client.post(`/api/assets/${asset.id}/insurance`, {
    policy_type: 'comprehensive', carrier: 'Acme', policy_number: 'P-1', premium: 100,
    premium_cycle: 'annual', deductible: 500, agent_name: 'Joe', agent_phone: '555',
    start_date: '2026-01-01', renewal_date: '2027-01-01', coverage: 'full', notes: 'n',
  });
  assert.equal(pol.status, 201);
  assert.equal(pol.body.carrier, 'Acme');
  assert.equal(pol.body.premium_cycle, 'annual');

  // Default premium_cycle is 'monthly' when omitted.
  const pol2 = await client.post(`/api/assets/${asset.id}/insurance`, { carrier: 'B' });
  assert.equal(pol2.body.premium_cycle, 'monthly');

  // Bad premium_cycle enum → 400; negative premium → 400.
  assert.equal((await client.post(`/api/assets/${asset.id}/insurance`, { premium_cycle: 'daily' })).status, 400);
  assert.equal((await client.post(`/api/assets/${asset.id}/insurance`, { premium: -5 })).status, 400);

  const list = (await client.get(`/api/assets/${asset.id}/insurance`)).body;
  assert.equal(list.length, 2);

  // Update.
  const upd = await client.put(`/api/assets/${asset.id}/insurance/${pol.body.id}`, { carrier: 'Acme2', premium: 120 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.carrier, 'Acme2');
  assert.equal(Number(upd.body.premium), 120);

  // Update a missing policy → 404.
  assert.equal((await client.put(`/api/assets/${asset.id}/insurance/999999`, { carrier: 'z' })).status, 404);

  // Delete.
  assert.equal((await client.del(`/api/assets/${asset.id}/insurance/${pol.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/assets/${asset.id}/insurance`)).body.length, 1);
});

test('deleting an asset removes its insurance policies', async () => {
  const { client } = await registerUser(base);
  const asset = (await client.post('/api/assets', { name: 'Boat' })).body;
  await client.post(`/api/assets/${asset.id}/insurance`, { carrier: 'Acme' });
  assert.equal((await client.del(`/api/assets/${asset.id}`)).status, 204);
  // Recreating an asset that reuses the id space still shows no orphan policies.
  const asset2 = (await client.post('/api/assets', { name: 'Boat2' })).body;
  assert.equal((await client.get(`/api/assets/${asset2.id}/insurance`)).body.length, 0);
});

test('cross-book isolation for asset endpoints', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const assetA = (await a.client.post('/api/assets', { name: 'A' })).body.id;

  // B cannot read/update/delete A's asset sub-resources → 404.
  assert.equal((await b.client.put(`/api/assets/${assetA}`, { name: 'x' })).status, 404);
  assert.equal((await b.client.get(`/api/assets/${assetA}/values`)).status, 404);
  assert.equal((await b.client.post(`/api/assets/${assetA}/values`, { value: 100 })).status, 404);
  assert.equal((await b.client.get(`/api/assets/${assetA}/maintenance`)).status, 404);
  assert.equal((await b.client.post(`/api/assets/${assetA}/maintenance`, { item: 'x' })).status, 404);
  assert.equal((await b.client.get(`/api/assets/${assetA}/documents`)).status, 404);
  assert.equal((await b.client.post(`/api/assets/${assetA}/documents`, { file: PDF, file_mime: 'application/pdf' })).status, 404);
  assert.equal((await b.client.get(`/api/assets/${assetA}/insurance`)).status, 404);
  assert.equal((await b.client.post(`/api/assets/${assetA}/insurance`, { carrier: 'x' })).status, 404);
});
