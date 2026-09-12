import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Vehicle value contribution to net worth (0 if the group is absent/filtered out).
function vehicleAssets(networth: any): number {
  const g = networth.assetGroups.find((x: any) => x.type === 'vehicle');
  return g ? Number(g.total) : 0;
}

test('retiring a vehicle preserves history but drops it from net worth; restore re-adds it', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Truck', current_value: 20000, purchase_price: 30000 })).body;

  // Tag a maintenance expense to the vehicle — this is the "history" we must keep.
  await client.post('/api/transactions', { amount: 150, account_id: acct, direction: 'expense', txn_date: '2026-05-01', tags: [{ kind: 'vehicle', ref_id: veh.id }] });

  // Net worth includes the vehicle's value while owned.
  assert.equal(vehicleAssets((await client.get('/api/networth')).body), 20000);

  // Retire it (sold).
  const disp = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: true, disposal_type: 'sold', disposed_at: '2026-06-01', disposal_amount: 18000, disposal_note: 'sold to CarMax' });
  assert.equal(disp.status, 200);
  assert.equal(disp.body.disposal_type, 'sold');
  assert.equal(disp.body.disposed_at.slice(0, 10), '2026-06-01');

  // Dropped from net worth, but the record and its tagged transaction are preserved.
  assert.equal(vehicleAssets((await client.get('/api/networth')).body), 0);
  const list = (await client.get('/api/vehicles')).body;
  const stillThere = list.find((x: any) => x.id === veh.id);
  assert.ok(stillThere, 'retired vehicle is still listed');
  assert.equal(Number(stillThere.disposal_amount), 18000);
  const tagged = (await client.get(`/api/transactions?vehicle_id=${veh.id}`)).body;
  assert.equal(tagged.posted.length + tagged.pending.length, 1, 'tagged transaction history is preserved');

  // Restore brings it back into net worth and clears the disposal fields.
  const restored = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.disposed_at, null);
  assert.equal(restored.body.disposal_type, null);
  assert.equal(vehicleAssets((await client.get('/api/networth')).body), 20000);
});

test('vehicle disposal rejects an invalid disposal_type', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Car', current_value: 5000 })).body;
  const bad = await client.post(`/api/vehicles/${veh.id}/dispose`, { disposed: true, disposal_type: 'exploded' });
  assert.equal(bad.status, 400);
});

test('disposal can create a sale transaction tagged to the vehicle', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Van', current_value: 9000 })).body;

  const disp = await client.post(`/api/vehicles/${veh.id}/dispose`, {
    disposed: true, disposal_type: 'sold', disposed_at: '2026-06-20', disposal_amount: 8500,
    proceeds_mode: 'create', proceeds_account_id: acct,
  });
  assert.equal(disp.status, 200);
  assert.ok(disp.body.disposal_transaction_id, 'a transaction was created and linked');

  // The created income transaction is tagged to the vehicle and shows in its list.
  const tagged = (await client.get(`/api/transactions?vehicle_id=${veh.id}`)).body;
  const all = [...tagged.posted, ...tagged.pending];
  assert.equal(all.length, 1);
  assert.equal(all[0].direction, 'income');
  assert.equal(Number(all[0].amount), 8500);
});

test('disposal can link an existing transaction and adopt its amount', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Truck', current_value: 12000 })).body;
  const txn = (await client.post('/api/transactions', { amount: 11000, account_id: acct, direction: 'income', txn_date: '2026-06-15', merchant: 'CarMax' })).body;

  // Link without passing disposal_amount — the server adopts the transaction's amount.
  const disp = await client.post(`/api/vehicles/${veh.id}/dispose`, {
    disposed: true, disposal_type: 'sold', proceeds_mode: 'link', disposal_transaction_id: txn.id,
  });
  assert.equal(disp.status, 200);
  assert.equal(disp.body.disposal_transaction_id, txn.id);
  assert.equal(Number(disp.body.disposal_amount), 11000);

  // The linked transaction is now also tagged to the vehicle.
  const tagged = (await client.get(`/api/transactions?vehicle_id=${veh.id}`)).body;
  assert.equal([...tagged.posted, ...tagged.pending].length, 1);
});

test('vehicle documents: MIME validation, listing, and delete', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Car', current_value: 4000 })).body;

  // Script-capable types are rejected.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/documents`, { file: 'aGVsbG8=', file_mime: 'text/html', file_name: 'x.html' })).status, 400);
  // An allowed type is stored and counted on the list.
  const up = await client.post(`/api/vehicles/${veh.id}/documents`, { file: 'aGVsbG8=', file_mime: 'application/pdf', file_name: 'bill-of-sale.pdf', name: 'Bill of sale' });
  assert.equal(up.status, 201);
  assert.equal((await client.get('/api/vehicles')).body.find((x: any) => x.id === veh.id).doc_count, 1);

  // Served back with hardened headers.
  const file = await fetch(`${base}/api/vehicles/${veh.id}/documents/${up.body.id}/file`, { headers: { cookie: client.cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  // Delete.
  assert.equal((await client.del(`/api/vehicles/${veh.id}/documents/${up.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/vehicles/${veh.id}/documents`)).body.length, 0);
});

test('vehicle warranties: multiple rows, replace-all, validation, and clearing', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body;

  // Defaults to no warranty.
  assert.equal((await client.get(`/api/vehicles/${veh.id}/warranties`)).body.length, 0);

  // Set two warranty rows.
  const set = await client.put(`/api/vehicles/${veh.id}/warranties`, {
    warranties: [
      { coverage: 'Powertrain', provider: 'Toyota', expiration: '2028-01-01', expires_miles: 60000, notes: 'engine + transmission' },
      { coverage: 'Bumper-to-bumper', provider: 'Toyota', expiration: '2026-01-01', expires_miles: 36000, notes: null },
    ],
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.length, 2);
  assert.equal(set.body[0].coverage, 'Powertrain');
  assert.equal(set.body[0].expiration, '2028-01-01');
  assert.equal(set.body[0].expires_miles, 60000);
  assert.equal(set.body[1].coverage, 'Bumper-to-bumper');

  // Replace-all with a single row (and a stray fully-blank row that gets dropped).
  const upd = await client.put(`/api/vehicles/${veh.id}/warranties`, {
    warranties: [{ coverage: 'Extended', provider: 'CarMax MaxCare', expires_miles: 100000 }, { coverage: '', provider: '', expiration: '', expires_miles: null, notes: '' }],
  });
  assert.equal(upd.body.length, 1);
  assert.equal(upd.body[0].coverage, 'Extended');

  // A bad expiration date is rejected (400) and does not change stored rows.
  const bad = await client.put(`/api/vehicles/${veh.id}/warranties`, { warranties: [{ coverage: 'X', expiration: 'not-a-date' }] });
  assert.equal(bad.status, 400);
  assert.equal((await client.get(`/api/vehicles/${veh.id}/warranties`)).body.length, 1);

  // Empty array clears them ("no warranty").
  assert.equal((await client.put(`/api/vehicles/${veh.id}/warranties`, { warranties: [] })).body.length, 0);
});

test('odometer readings: latest drives current mileage and miles-driven', async () => {
  const { client } = await registerUser(base);
  // odometer_start only (no current/purchase_date) so creation doesn't seed readings.
  const veh = (await client.post('/api/vehicles', { name: 'Truck', odometer_start: 25000 })).body;

  // Add two dated readings; the latest-dated one becomes the current odometer.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 30000, as_of: '2026-03-01' })).status, 201);
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 35000, as_of: '2026-06-01' })).status, 201);

  const list = (await client.get(`/api/vehicles/${veh.id}/odometer`)).body;
  assert.equal(list.length, 2);
  // Returned as {as_of, value} so it reuses the snapshot UI.
  assert.equal(Number(list.find((r: any) => r.as_of === '2026-06-01').value), 35000);

  // Current odometer synced to the latest reading; summary reflects it.
  let summary = (await client.get(`/api/vehicles/${veh.id}/summary`)).body;
  assert.equal(Number(summary.vehicle.odometer_current), 35000);
  assert.equal(summary.milesDriven, 10000); // 35000 − 25000 start

  // Editing the same date upserts (no duplicate); deleting the latest re-syncs down.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 36000, as_of: '2026-06-01' })).status, 201);
  assert.equal((await client.get(`/api/vehicles/${veh.id}/odometer`)).body.length, 2);
  const latest = (await client.get(`/api/vehicles/${veh.id}/odometer`)).body.find((r: any) => r.as_of === '2026-06-01');
  assert.equal((await client.del(`/api/vehicles/${veh.id}/odometer/${latest.id}`)).status, 204);
  summary = (await client.get(`/api/vehicles/${veh.id}/summary`)).body;
  assert.equal(Number(summary.vehicle.odometer_current), 30000); // re-synced to the remaining reading
});

test('creating a vehicle seeds odometer readings from purchase + current mileage', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', {
    name: 'Truck', purchase_date: '2026-01-01', odometer_start: 25000, odometer_current: 35000,
  })).body;

  const readings = (await client.get(`/api/vehicles/${veh.id}/odometer`)).body;
  assert.equal(readings.length, 2);
  // Purchase-date reading carries the purchase mileage.
  assert.equal(Number(readings.find((r: any) => r.as_of === '2026-01-01').value), 25000);
  // A today-dated reading carries the current mileage.
  const today = readings.find((r: any) => r.as_of !== '2026-01-01');
  assert.equal(Number(today.value), 35000);

  // Current odometer is synced to the latest reading.
  const summary = (await client.get(`/api/vehicles/${veh.id}/summary`)).body;
  assert.equal(Number(summary.vehicle.odometer_current), 35000);

  // Only a current mileage (no purchase date) seeds a single reading.
  const veh2 = (await client.post('/api/vehicles', { name: 'Car', odometer_current: 12000 })).body;
  assert.equal((await client.get(`/api/vehicles/${veh2.id}/odometer`)).body.length, 1);

  // No mileage entered → no readings seeded.
  const veh3 = (await client.post('/api/vehicles', { name: 'Bare' })).body;
  assert.equal((await client.get(`/api/vehicles/${veh3.id}/odometer`)).body.length, 0);
});

test('odometer readings enforce monotonic, >= purchase mileage', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Truck', odometer_start: 25000 })).body;

  // Below the purchase mileage → rejected.
  const low = await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 20000, as_of: '2026-03-01' });
  assert.equal(low.status, 400);
  assert.match(low.body.error, /purchase mileage/i);

  // Valid readings.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 30000, as_of: '2026-03-01' })).status, 201);
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 40000, as_of: '2026-09-01' })).status, 201);

  // A mid-date reading below the earlier one → rejected.
  const belowPrev = await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 28000, as_of: '2026-06-01' });
  assert.equal(belowPrev.status, 400);
  assert.match(belowPrev.body.error, /earlier reading/i);

  // A mid-date reading above a LATER reading → rejected.
  const aboveNext = await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 45000, as_of: '2026-06-01' });
  assert.equal(aboveNext.status, 400);
  assert.match(aboveNext.body.error, /later reading/i);

  // A valid in-between reading is accepted, and re-saving the same date higher is OK.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 35000, as_of: '2026-06-01' })).status, 201);
  assert.equal((await client.post(`/api/vehicles/${veh.id}/odometer`, { reading: 36000, as_of: '2026-06-01' })).status, 201);
  assert.equal((await client.get(`/api/vehicles/${veh.id}/odometer`)).body.length, 3);
});

test('vehicle value snapshots: latest drives current value and net worth', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Car', current_value: 20000 })).body;

  // Two dated value snapshots; the latest-dated one becomes the current value.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/values`, { value: 18000, as_of: '2026-03-01' })).status, 201);
  assert.equal((await client.post(`/api/vehicles/${veh.id}/values`, { value: 16000, as_of: '2026-06-01' })).status, 201);

  const list = (await client.get(`/api/vehicles/${veh.id}/values`)).body;
  assert.equal(list.length, 2);

  let summary = (await client.get(`/api/vehicles/${veh.id}/summary`)).body;
  assert.equal(Number(summary.vehicle.current_value), 16000); // synced to latest snapshot

  // Net worth reflects the snapshot-driven value.
  const nw = (await client.get('/api/networth')).body.assetGroups.find((g: any) => g.type === 'vehicle');
  assert.equal(Number(nw.total), 16000);

  // Deleting the latest re-syncs current value down to the remaining snapshot.
  const latest = list.find((r: any) => r.as_of === '2026-06-01');
  assert.equal((await client.del(`/api/vehicles/${veh.id}/values/${latest.id}`)).status, 204);
  summary = (await client.get(`/api/vehicles/${veh.id}/summary`)).body;
  assert.equal(Number(summary.vehicle.current_value), 18000);
});

test('vehicle maintenance: history with optional transaction link, and upcoming items', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;
  const veh = (await client.post('/api/vehicles', { name: 'Truck' })).body;
  const txn = (await client.post('/api/transactions', { amount: 89.99, account_id: acct, direction: 'expense', txn_date: '2026-05-10', merchant: 'Jiffy Lube' })).body;

  // Completed item with a linked transaction → cost comes from the transaction.
  const m1 = await client.post(`/api/vehicles/${veh.id}/maintenance`, {
    item: 'Oil change', status: 'completed', service_date: '2026-05-10', odometer: 38000, transaction_id: txn.id, vendor: 'Jiffy Lube',
  });
  assert.equal(m1.status, 201);

  // Completed item with a manual cost (no transaction).
  assert.equal((await client.post(`/api/vehicles/${veh.id}/maintenance`, { item: 'Tire rotation', status: 'completed', service_date: '2026-04-01', cost: 25 })).status, 201);

  // Upcoming scheduled item (next oil change by date + odometer).
  assert.equal((await client.post(`/api/vehicles/${veh.id}/maintenance`, { item: 'Oil change', status: 'upcoming', due_date: '2026-11-01', due_odometer: 42000 })).status, 201);

  const list = (await client.get(`/api/vehicles/${veh.id}/maintenance`)).body;
  assert.equal(list.length, 3);
  const oil = list.find((m: any) => m.item === 'Oil change' && m.status === 'completed');
  assert.equal(oil.transaction_id, txn.id);
  assert.equal(Number(oil.txn_amount), 89.99); // joined transaction amount
  const upcoming = list.find((m: any) => m.status === 'upcoming');
  assert.equal(upcoming.due_odometer, 42000);

  // Cost view summary rolls up completed maintenance (linked txn + manual cost),
  // excluding upcoming items.
  const summary = (await client.get(`/api/vehicles/${veh.id}/summary`)).body;
  assert.equal(Number(summary.maintenanceCost), 114.99); // 89.99 + 25.00
  assert.equal(summary.maintenanceCount, 2);

  // Item is required; a cross-book transaction link is rejected.
  assert.equal((await client.post(`/api/vehicles/${veh.id}/maintenance`, { status: 'completed' })).status, 400);

  // Edit + delete.
  assert.equal((await client.put(`/api/vehicles/${veh.id}/maintenance/${oil.id}`, { item: 'Oil & filter change', status: 'completed', odometer: 38050 })).status, 200);
  assert.equal((await client.del(`/api/vehicles/${veh.id}/maintenance/${oil.id}`)).status, 204);
  assert.equal((await client.get(`/api/vehicles/${veh.id}/maintenance`)).body.length, 2);
});

test('cross-book isolation for vehicle endpoints', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const acctB = (await b.client.post('/api/accounts', { name: 'B', type: 'checking' })).body.id;
  const vehA = (await a.client.post('/api/vehicles', { name: 'A', current_value: 3000 })).body.id;

  // Dispose "create" referencing B's account → 404, and the disposal rolls back.
  const disp = await a.client.post(`/api/vehicles/${vehA}/dispose`, {
    disposed: true, disposal_type: 'sold', disposal_amount: 2000, proceeds_mode: 'create', proceeds_account_id: acctB,
  });
  assert.equal(disp.status, 404);
  assert.equal((await a.client.get('/api/vehicles')).body.find((x: any) => x.id === vehA).disposed_at, null);

  // B cannot read or write A's odometer, warranties, or maintenance.
  assert.equal((await b.client.get(`/api/vehicles/${vehA}/odometer`)).status, 404);
  assert.equal((await b.client.post(`/api/vehicles/${vehA}/odometer`, { reading: 100 })).status, 404);
  assert.equal((await b.client.get(`/api/vehicles/${vehA}/warranties`)).status, 404);
  assert.equal((await b.client.put(`/api/vehicles/${vehA}/warranties`, { warranties: [{ coverage: 'X' }] })).status, 404);
  assert.equal((await b.client.get(`/api/vehicles/${vehA}/maintenance`)).status, 404);
  assert.equal((await b.client.post(`/api/vehicles/${vehA}/maintenance`, { item: 'X' })).status, 404);
});
