import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Guards the regression where money() was tightened to reject sub-cent precision: it
// must NOT be applied to non-money fields that are legitimately more precise than cents
// (interest rates, acreage, utility usage, item quantities), while still rejecting
// sub-cent precision on actual money fields.
test('non-money numeric fields accept >2 decimals; money fields still reject sub-cent', async () => {
  const { client } = await registerUser(base);

  // lot_size_acres is NUMERIC(12,3) — three decimals must be accepted.
  const prop = await client.post('/api/properties', { name: 'Acre Test', lot_size_acres: 0.125 });
  assert.equal(prop.status, 201, 'a 3-decimal lot size must be accepted (not treated as money)');

  // interest_rate is NUMERIC(6,3) — a 3-decimal rate must be accepted.
  const liab = await client.post('/api/liabilities', { name: 'Loan', interest_rate: 6.125, balance: 1000 });
  assert.equal(liab.status, 201, 'a 3-decimal interest rate must be accepted');

  // But a money field with sub-cent precision is still rejected.
  const bad = await client.post('/api/liabilities', { name: 'Loan2', balance: 100.005 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /whole cents/);
});
