import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// A date `n` days from today (local), as YYYY-MM-DD. Used to place reminders inside
// the route's window (~30 days overdue through 60 days out).
function daysFromToday(n: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const IN_WINDOW = daysFromToday(20);   // safely inside +60
const OUT_OF_WINDOW = daysFromToday(120); // beyond +60

// An empty book has nothing upcoming.
test('GET /reminders: empty book returns []', async () => {
  const { client } = await registerUser(base);
  const res = await client.get('/api/reminders');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

// A subscription renewal (active + next_due_date in window) surfaces with its amount.
test('GET /reminders: active subscription renewal appears with amount', async () => {
  const { client } = await registerUser(base);
  const sub = (await client.post('/api/subscriptions', { name: 'Netflix', amount: 1599, billing_cycle: 'monthly', next_due_date: IN_WINDOW })).body;

  const items = (await client.get('/api/reminders')).body;
  const r = items.find((x: any) => x.source === 'subscription' && x.kind === 'renewal');
  assert.ok(r, 'renewal reminder present');
  assert.equal(r.title, 'Netflix');
  assert.equal(r.subtitle, 'Subscription renews');
  assert.equal(r.date, IN_WINDOW);
  assert.equal(r.amount, 1599);
  assert.equal(r.link, `/subscriptions/${sub.id}`);
});

// A scheduled subscription cancellation surfaces a 'cancels' reminder.
test('GET /reminders: a scheduled subscription cancellation appears', async () => {
  const { client } = await registerUser(base);
  const sub = (await client.post('/api/subscriptions', { name: 'Spotify', amount: 999, billing_cycle: 'monthly' })).body;
  // Schedule a future cancellation (stays active, end_date set).
  await client.post(`/api/subscriptions/${sub.id}/cancel`, { date: IN_WINDOW });

  const items = (await client.get('/api/reminders')).body;
  const cancels = items.find((x: any) => x.source === 'subscription' && x.kind === 'cancels');
  assert.ok(cancels, 'cancels reminder present');
  assert.equal(cancels.date, IN_WINDOW);
  assert.equal(cancels.amount, null);
});

// A subscription due out of the window is not returned.
test('GET /reminders: out-of-window subscription is filtered out', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/subscriptions', { name: 'Faraway', amount: 500, billing_cycle: 'yearly', next_due_date: OUT_OF_WINDOW });
  const items = (await client.get('/api/reminders')).body;
  assert.equal(items.find((x: any) => x.title === 'Faraway'), undefined);
});

// A utility bill_due (active + due_day) and a scheduled cancellation.
test('GET /reminders: utility bill due (by due day) and scheduled cancellation', async () => {
  const { client } = await registerUser(base);
  // due_day drives nextByDay → always within the next ~31 days → in window.
  const due = new Date().getDate();
  const u = (await client.post('/api/utilities/accounts', { name: 'Power Co', utility_type: 'electricity', due_day: due })).body;
  const items = (await client.get('/api/reminders')).body;
  const bill = items.find((x: any) => x.source === 'utility' && x.kind === 'bill_due');
  assert.ok(bill, 'utility bill_due present');
  assert.equal(bill.title, 'Power Co');
  assert.equal(bill.link, `/utilities/${u.id}`);

  // Schedule a cancellation → 'cancels'.
  await client.post(`/api/utilities/accounts/${u.id}/cancel`, { date: IN_WINDOW });
  const items2 = (await client.get('/api/reminders')).body;
  assert.ok(items2.find((x: any) => x.source === 'utility' && x.kind === 'cancels'));
});

// A liability account with a due_day surfaces a payment_due; a scheduled close surfaces
// a 'closes' reminder (a future close date keeps the account un-archived so it's read).
test('GET /reminders: liability account payment due and scheduled close', async () => {
  const { client } = await registerUser(base);
  const due = new Date().getDate();
  const acct = (await client.post('/api/accounts', { name: 'Card', type: 'credit_card', is_liability: true, due_day: due })).body.id;

  let items = (await client.get('/api/reminders')).body;
  const pay = items.find((x: any) => x.source === 'account' && x.kind === 'payment_due');
  assert.ok(pay, 'account payment_due present');
  assert.equal(pay.title, 'Card');
  assert.equal(pay.link, `/accounts/${acct}`);

  // Schedule a future close (keeps it active/un-archived, sets closed_at in window).
  await client.post(`/api/accounts/${acct}/close`, { closed: true, closed_at: IN_WINDOW });
  items = (await client.get('/api/reminders')).body;
  const closes = items.find((x: any) => x.source === 'account' && x.kind === 'closes');
  assert.ok(closes, 'account closes present');
  assert.equal(closes.date, IN_WINDOW);
});

// A non-liability account, or a liability account with no due_day, yields no payment_due.
test('GET /reminders: a non-liability account produces no payment_due', async () => {
  const { client } = await registerUser(base);
  const due = new Date().getDate();
  await client.post('/api/accounts', { name: 'Checking', type: 'checking', due_day: due });
  const items = (await client.get('/api/reminders')).body;
  assert.equal(items.find((x: any) => x.source === 'account' && x.kind === 'payment_due'), undefined);
});

// Insurance renewals for a vehicle, a property, and a generic asset.
test('GET /reminders: insurance renewals across vehicle, property, and asset', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Truck', current_value: 10000 })).body;
  const prop = (await client.post('/api/properties', { name: 'House', current_value: 300000 })).body;
  const asset = (await client.post('/api/assets', { name: 'Boat', asset_type: 'boat', value: 20000, has_insurance: true })).body;

  await client.post(`/api/vehicles/${veh.id}/insurance`, { policy_type: 'Auto', carrier: 'Geico', premium: 12000, renewal_date: IN_WINDOW });
  await client.post(`/api/properties/${prop.id}/insurance`, { policy_type: 'Home', carrier: 'State Farm', premium: 8000, renewal_date: IN_WINDOW });
  await client.post(`/api/assets/${asset.id}/insurance`, { policy_type: 'Boat', carrier: 'Progressive', premium: 3000, renewal_date: IN_WINDOW });

  const items = (await client.get('/api/reminders')).body;
  const ins = items.filter((x: any) => x.source === 'insurance');
  assert.equal(ins.length, 3);
  const vIns = ins.find((x: any) => x.title === 'Truck');
  assert.ok(vIns);
  assert.equal(vIns.kind, 'insurance_renewal');
  assert.match(vIns.subtitle, /Auto · Geico renews/);
  assert.equal(vIns.amount, 12000);
  assert.equal(vIns.link, `/vehicles/${veh.id}`);
  assert.equal(ins.find((x: any) => x.title === 'House').link, `/properties/${prop.id}`);
  assert.equal(ins.find((x: any) => x.title === 'Boat').link, `/other-assets/${asset.id}`);
});

// Upcoming maintenance for a vehicle, a property, and an asset.
test('GET /reminders: upcoming maintenance across vehicle, property, and asset', async () => {
  const { client } = await registerUser(base);
  const veh = (await client.post('/api/vehicles', { name: 'Van' })).body;
  const prop = (await client.post('/api/properties', { name: 'Cabin', current_value: 100000 })).body;
  const asset = (await client.post('/api/assets', { name: 'Tractor', asset_type: 'equipment', value: 5000, has_maintenance: true })).body;

  await client.post(`/api/vehicles/${veh.id}/maintenance`, { item: 'Oil change', status: 'upcoming', due_date: IN_WINDOW });
  await client.post(`/api/properties/${prop.id}/maintenance`, { item: 'Roof inspection', status: 'upcoming', due_date: IN_WINDOW });
  await client.post(`/api/assets/${asset.id}/maintenance`, { item: 'Service', status: 'upcoming', due_date: IN_WINDOW });

  const items = (await client.get('/api/reminders')).body;
  const maint = items.filter((x: any) => x.source === 'maintenance');
  assert.equal(maint.length, 3);
  const v = maint.find((x: any) => x.title === 'Van');
  assert.equal(v.subtitle, 'Maintenance: Oil change');
  assert.equal(v.link, `/vehicles/${veh.id}`);
  assert.equal(maint.find((x: any) => x.title === 'Cabin').link, `/properties/${prop.id}`);
  assert.equal(maint.find((x: any) => x.title === 'Tractor').link, `/other-assets/${asset.id}`);

  // A completed maintenance item is NOT surfaced (only status='upcoming').
  await client.post(`/api/vehicles/${veh.id}/maintenance`, { item: 'Tires', status: 'completed', service_date: IN_WINDOW });
  const after = (await client.get('/api/reminders')).body.filter((x: any) => x.source === 'maintenance');
  assert.equal(after.length, 3, 'completed maintenance excluded');
});

// A rental property with a lease_end in the window surfaces a lease_end reminder.
test('GET /reminders: a rental lease ending appears', async () => {
  const { client } = await registerUser(base);
  const prop = (await client.post('/api/properties', { name: 'Rental Unit', current_value: 200000, is_rental: true, lease_end: IN_WINDOW })).body;
  const items = (await client.get('/api/reminders')).body;
  const lease = items.find((x: any) => x.source === 'lease' && x.kind === 'lease_end');
  assert.ok(lease, 'lease_end reminder present');
  assert.equal(lease.title, 'Rental Unit');
  assert.equal(lease.link, `/properties/${prop.id}`);

  // A non-rental property with a lease_end does NOT surface one.
  await client.post('/api/properties', { name: 'Owner Occupied', current_value: 100000, is_rental: false, lease_end: IN_WINDOW });
  const after = (await client.get('/api/reminders')).body.filter((x: any) => x.source === 'lease');
  assert.equal(after.length, 1);
});

// Results are sorted soonest-first across sources.
test('GET /reminders: items are sorted by date ascending', async () => {
  const { client } = await registerUser(base);
  await client.post('/api/subscriptions', { name: 'Later', amount: 100, billing_cycle: 'monthly', next_due_date: daysFromToday(40) });
  await client.post('/api/subscriptions', { name: 'Sooner', amount: 100, billing_cycle: 'monthly', next_due_date: daysFromToday(5) });

  const items = (await client.get('/api/reminders')).body;
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].date <= items[i].date, 'ascending by date');
  }
  const sooner = items.findIndex((x: any) => x.title === 'Sooner');
  const later = items.findIndex((x: any) => x.title === 'Later');
  assert.ok(sooner < later);
});

// Tenant isolation: one book's obligations never appear in another's reminders.
test('GET /reminders is tenant scoped', async () => {
  const a = await registerUser(base);
  const b = await registerUser(base);
  await a.client.post('/api/subscriptions', { name: 'A sub', amount: 100, billing_cycle: 'monthly', next_due_date: IN_WINDOW });
  assert.deepEqual((await b.client.get('/api/reminders')).body, []);
  assert.ok((await a.client.get('/api/reminders')).body.length >= 1);
});
