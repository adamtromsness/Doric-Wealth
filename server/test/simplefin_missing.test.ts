import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient } from './helpers.js';
import { upsertAccountLinks, markAbsentLinks } from '../src/routes/connections.js';
import { encryptSecret } from '../src/secrets.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

const sfAcct = (id: string, name: string): any => ({
  org: { name: 'Test Bank' }, id, name, currency: 'USD', balance: '10.00', 'balance-date': 1700000000, transactions: [],
});

test('an external account that stops appearing is flagged missing, then cleared when it returns', async () => {
  const { bookId } = await registerUser(base);
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];
    // Both accounts seen initially.
    await upsertAccountLinks(db as any, bookId, link.id, [sfAcct('a-1', 'Checking'), sfAcct('a-2', 'Savings')]);
    await markAbsentLinks(db as any, bookId, link.id, ['a-1', 'a-2']);

    const missingOf = async (ext: string) =>
      (await db.query(`SELECT missing_since FROM account_links WHERE link_id = $1 AND external_account_id = $2`, [link.id, ext])).rows[0].missing_since;
    assert.equal(await missingOf('a-1'), null);
    assert.equal(await missingOf('a-2'), null);

    // Next sync returns only a-1 → a-2 is flagged missing.
    await upsertAccountLinks(db as any, bookId, link.id, [sfAcct('a-1', 'Checking')]);
    await markAbsentLinks(db as any, bookId, link.id, ['a-1']);
    assert.equal(await missingOf('a-1'), null, 'a-1 still present');
    assert.ok(await missingOf('a-2'), 'a-2 flagged missing');

    // Guard: an empty present set must NOT flag everything.
    await markAbsentLinks(db as any, bookId, link.id, []);
    assert.equal(await missingOf('a-1'), null, 'empty pull did not flag a-1');

    // a-2 comes back → its flag is cleared.
    await upsertAccountLinks(db as any, bookId, link.id, [sfAcct('a-2', 'Savings')]);
    assert.equal(await missingOf('a-2'), null, 'returning account is un-flagged');
  } finally { await db.end(); }
});
