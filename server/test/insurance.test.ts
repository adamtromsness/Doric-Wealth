import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// The insurance routes are shared (mountInsuranceRoutes) across property/vehicle/asset.
// These tests drive the full CRUD + validation surface via the property mount, then
// spot-check the vehicle mount to cover the other `kind` binding.

test('insurance CRUD + validation on a property', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'House' })).body;

  // Empty list initially.
  assert.equal((await client.get(`/api/properties/${prop.id}/insurance`)).body.length, 0);

  // Create a fully-populated policy.
  const created = await client.post(`/api/properties/${prop.id}/insurance`, {
    policy_type: 'homeowners', carrier: 'State Farm', policy_number: 'HO-123', premium: 1200,
    premium_cycle: 'annual', coverage: 'dwelling + liability', deductible: 1000,
    agent_name: 'Jane', agent_phone: '555-1212', start_date: '2026-01-01', renewal_date: '2027-01-01',
    notes: 'primary residence',
  });
  assert.equal(created.status, 201);
  const pol = created.body;
  assert.equal(pol.entity_kind, 'property');
  assert.equal(pol.entity_id, prop.id);
  assert.equal(pol.carrier, 'State Farm');
  assert.equal(pol.premium_cycle, 'annual');
  assert.equal(Number(pol.premium), 1200);
  assert.equal(pol.start_date, '2026-01-01');
  assert.equal(pol.renewal_date, '2027-01-01');

  // Minimal policy defaults premium_cycle to 'monthly'.
  const min = await client.post(`/api/properties/${prop.id}/insurance`, {});
  assert.equal(min.status, 201);
  assert.equal(min.body.premium_cycle, 'monthly');
  assert.equal(min.body.carrier, null);

  // List is ordered by renewal_date NULLS LAST — 2 rows now.
  const list = (await client.get(`/api/properties/${prop.id}/insurance`)).body;
  assert.equal(list.length, 2);

  // Update.
  const upd = await client.put(`/api/properties/${prop.id}/insurance/${pol.id}`, {
    carrier: 'Allstate', premium: 1300, premium_cycle: 'semiannual', deductible: 500,
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.carrier, 'Allstate');
  assert.equal(Number(upd.body.premium), 1300);
  assert.equal(upd.body.premium_cycle, 'semiannual');
  assert.equal(Number(upd.body.deductible), 500);

  // Delete.
  assert.equal((await client.del(`/api/properties/${prop.id}/insurance/${pol.id}`)).status, 204);
  assert.equal((await client.get(`/api/properties/${prop.id}/insurance`)).body.length, 1);
});

test('insurance validation errors → 400', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'House' })).body;

  // Bad premium_cycle enum.
  assert.equal((await client.post(`/api/properties/${prop.id}/insurance`, { premium_cycle: 'biweekly' })).status, 400);
  // Negative money is rejected (min: 0).
  assert.equal((await client.post(`/api/properties/${prop.id}/insurance`, { premium: -1 })).status, 400);
  assert.equal((await client.post(`/api/properties/${prop.id}/insurance`, { deductible: -1 })).status, 400);
  // Sub-cent money.
  assert.equal((await client.post(`/api/properties/${prop.id}/insurance`, { premium: 1.005 })).status, 400);
  // Bad date.
  assert.equal((await client.post(`/api/properties/${prop.id}/insurance`, { renewal_date: 'nope' })).status, 400);
  // Over-length string (carrier max 120).
  assert.equal((await client.post(`/api/properties/${prop.id}/insurance`, { carrier: 'x'.repeat(121) })).status, 400);

  // Update with a bad enum on an existing policy → 400.
  const pol = (await client.post(`/api/properties/${prop.id}/insurance`, { carrier: 'A' })).body;
  assert.equal((await client.put(`/api/properties/${prop.id}/insurance/${pol.id}`, { premium_cycle: 'never' })).status, 400);

  // Update a missing policy → 404.
  assert.equal((await client.put(`/api/properties/${prop.id}/insurance/999999`, { carrier: 'z' })).status, 404);
});

test('insurance routes are entity-scoped (property vs vehicle share the mount)', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'House' })).body;
  const veh = (await client.post('/api/vehicles', { name: 'Car' })).body;

  // A property policy and a vehicle policy are stored under distinct entity_kind
  // and do not leak across entities.
  await client.post(`/api/properties/${prop.id}/insurance`, { carrier: 'PropIns' });
  const vp = await client.post(`/api/vehicles/${veh.id}/insurance`, { carrier: 'VehIns', premium_cycle: 'quarterly' });
  assert.equal(vp.status, 201);
  assert.equal(vp.body.entity_kind, 'vehicle');
  assert.equal(vp.body.premium_cycle, 'quarterly');

  const propList = (await client.get(`/api/properties/${prop.id}/insurance`)).body;
  const vehList = (await client.get(`/api/vehicles/${veh.id}/insurance`)).body;
  assert.equal(propList.length, 1);
  assert.equal(propList[0].carrier, 'PropIns');
  assert.equal(vehList.length, 1);
  assert.equal(vehList[0].carrier, 'VehIns');

  // Deleting the vehicle policy leaves the property policy intact.
  assert.equal((await client.del(`/api/vehicles/${veh.id}/insurance/${vp.body.id}`)).status, 204);
  assert.equal((await client.get(`/api/properties/${prop.id}/insurance`)).body.length, 1);
});

test('cross-book isolation for insurance endpoints', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  const propA = (await a.client.post('/api/properties', { name: 'A' })).body.id;
  const pol = (await a.client.post(`/api/properties/${propA}/insurance`, { carrier: 'A' })).body;

  // B cannot list/create/update/delete against A's property → 404 (owned() guard).
  assert.equal((await b.client.get(`/api/properties/${propA}/insurance`)).status, 404);
  assert.equal((await b.client.post(`/api/properties/${propA}/insurance`, { carrier: 'x' })).status, 404);
  assert.equal((await b.client.put(`/api/properties/${propA}/insurance/${pol.id}`, { carrier: 'x' })).status, 404);
  assert.equal((await b.client.del(`/api/properties/${propA}/insurance/${pol.id}`)).status, 404);
});
