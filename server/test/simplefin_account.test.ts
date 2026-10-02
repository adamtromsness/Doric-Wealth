import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { encryptSecret } from '../src/secrets.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Insert a SimpleFIN connection + one external account link (optionally mapped).
async function seedLink(bookId: number, ext: string, fields: any, accountId: number | null) {
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];
    await db.query(
      `INSERT INTO account_links (book_id, link_id, external_account_id, name, org_name, currency, last_balance, last_balance_date, account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8), $9)`,
      [bookId, link.id, ext, fields.name, fields.org_name, fields.currency, fields.last_balance, fields.balance_epoch, accountId]
    );
    return link.id as number;
  } finally { await db.end(); }
}

test('create-account builds a local account pre-filled from SimpleFIN and links it', async () => {
  const { client, bookId } = await registerUser(base);
  const linkId = await seedLink(bookId, 'ext-1',
    { name: 'Premier Checking', org_name: 'Test Bank', currency: 'USD', last_balance: 1234.56, balance_epoch: 1700000000 }, null);

  const r = await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: 'ext-1', type: 'checking' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Premier Checking');
  assert.equal(r.body.institution, 'Test Bank');
  assert.equal(r.body.currency, 'USD');
  assert.equal(r.body.type, 'checking');
  const acctId = r.body.id;

  // The external account is now linked, and the SimpleFIN balance was recorded.
  const conns = (await client.get('/api/connections')).body;
  const link = conns.find((c: any) => c.id === linkId).accounts.find((a: any) => a.external_account_id === 'ext-1');
  assert.equal(link.account_id, acctId);
  const balances = (await client.get(`/api/accounts/${acctId}/balances`)).body;
  assert.ok(balances.length >= 1, 'a balance snapshot was recorded');

  // It can't be created twice.
  assert.equal((await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: 'ext-1' })).status, 409);
});

test('a credit-card type is marked a liability', async () => {
  const { client, bookId } = await registerUser(base);
  const linkId = await seedLink(bookId, 'card-1',
    { name: 'Rewards Card', org_name: 'Card Co', currency: 'USD', last_balance: -500, balance_epoch: 1700000000 }, null);
  const r = await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: 'card-1', type: 'credit_card' });
  assert.equal(r.status, 201);
  assert.equal(r.body.is_liability, true);
});

test('apply-settings overwrites a mapped account from SimpleFIN', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Old Name', type: 'checking', institution: 'Old Bank', currency: 'USD' })).body;
  const linkId = await seedLink(bookId, 'ext-2',
    { name: 'Everyday Savings', org_name: 'New Bank', currency: 'usd', last_balance: 999.99, balance_epoch: 1700000000 }, acct.id);

  const r = await client.post(`/api/connections/${linkId}/apply-settings`, { external_account_id: 'ext-2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Everyday Savings');
  assert.equal(r.body.institution, 'New Bank');
  assert.equal(r.body.currency, 'USD', 'normalized (only USD is supported)');

  // apply-settings on an unmapped external account is rejected.
  const linkId2 = await seedLink(bookId, 'ext-3',
    { name: 'Unmapped', org_name: 'Bank', currency: 'USD', last_balance: 1, balance_epoch: 1700000000 }, null);
  assert.equal((await client.post(`/api/connections/${linkId2}/apply-settings`, { external_account_id: 'ext-3' })).status, 400);
});
