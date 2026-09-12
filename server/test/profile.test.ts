import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

test('profile supports partial section updates without clobbering other sections', async () => {
  const { client } = await registerUser(base);

  // Occupation tab saves only its fields.
  let r = await client.put('/api/auth/profile', { employer: 'Acme', job_title: 'Engineer', annual_income: '85000' });
  assert.equal(r.status, 200);
  // Retirement tab saves only its fields — occupation must remain.
  r = await client.put('/api/auth/profile', { target_retirement_age: '65', monthly_contribution: '500.50' });
  assert.equal(r.status, 200);

  const p = (await client.get('/api/auth/profile')).body;
  assert.equal(p.employer, 'Acme');
  assert.equal(p.job_title, 'Engineer');
  assert.equal(p.annual_income, 85000);
  assert.equal(p.target_retirement_age, 65);
  assert.equal(p.monthly_contribution, 500.5);
});

test('updating name parts keeps the legacy display name in sync; dob is validated', async () => {
  const { client } = await registerUser(base);
  await client.put('/api/auth/profile', { first_name: 'Ada', last_name: 'Lovelace', dob: '1990-12-10' });
  const p = (await client.get('/api/auth/profile')).body;
  assert.equal(p.name, 'Ada Lovelace');
  assert.equal(p.dob, '1990-12-10');
  // A preferred name wins for the display name.
  await client.put('/api/auth/profile', { preferred_name: 'Addy' });
  assert.equal((await client.get('/api/auth/profile')).body.name, 'Addy');
  // Bad date is rejected.
  assert.equal((await client.put('/api/auth/profile', { dob: 'not-a-date' })).status, 400);
});

test('dependants CRUD is scoped to the user', async () => {
  const { client } = await registerUser(base);
  const created = await client.post('/api/auth/dependants', { first_name: 'Kid', middle_name: 'Q', last_name: 'One', relationship: 'Child', dob: '2015-05-05' });
  assert.equal(created.status, 200);
  const id = created.body.id;

  let p = (await client.get('/api/auth/profile')).body;
  assert.equal(p.dependants.length, 1);
  assert.equal(p.dependants[0].first_name, 'Kid');
  assert.equal(p.dependants[0].last_name, 'One');
  assert.equal(p.dependants[0].name, 'Kid Q One', 'display name is derived from the parts');
  assert.equal(p.dependants[0].dob, '2015-05-05');

  const upd = await client.put(`/api/auth/dependants/${id}`, { first_name: 'Kid', last_name: 'Uno' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Kid Uno');

  assert.equal((await client.del(`/api/auth/dependants/${id}`)).status, 200);
  p = (await client.get('/api/auth/profile')).body;
  assert.equal(p.dependants.length, 0);

  // A dependant needs a name.
  assert.equal((await client.post('/api/auth/dependants', { relationship: 'Child' })).status, 400);

  // Another user can't see or modify the first user's dependants.
  const created2 = await client.post('/api/auth/dependants', { name: 'Visible only to me' });
  const other = await registerUser(base);
  assert.equal((await other.client.get('/api/auth/profile')).body.dependants.length, 0);
  assert.equal((await other.client.del(`/api/auth/dependants/${created2.body.id}`)).status, 200); // no-op delete, still 200
  assert.equal((await client.get('/api/auth/profile')).body.dependants.length, 1, "other user's delete didn't touch my dependant");
});

test('timezone round-trips through the profile and reaches /auth/me', async () => {
  const { client } = await registerUser(base);
  // Defaults to null (UTC) until set.
  assert.equal((await client.get('/api/auth/profile')).body.timezone ?? null, null);

  const upd = await client.put('/api/auth/profile', { timezone: 'America/Los_Angeles' });
  assert.equal(upd.status, 200);
  assert.equal((await client.get('/api/auth/profile')).body.timezone, 'America/Los_Angeles');
  // The auth payload (used by the client to decide whether to auto-capture) carries it too.
  assert.equal((await client.get('/api/auth/me')).body.user.timezone, 'America/Los_Angeles');
});
