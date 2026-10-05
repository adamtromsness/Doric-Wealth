import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startServer, stopServer, registerUser } from './helpers.js';
import { TEST_DATABASE_URL } from './config.js';
import { config } from '../src/config.js';
import { encryptSecret } from '../src/secrets.js';
import { ensureKeyCheck, verifyKey, runCli } from '../src/keyCheck.js';

let pool: pg.Pool;
let base: string;
before(async () => { base = await startServer(); pool = new pg.Pool({ connectionString: TEST_DATABASE_URL }); await pool.query(`DELETE FROM app_meta`); });
after(async () => { await pool.end(); await stopServer(); });

async function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const saved = config.secretKey;
  (config as any).secretKey = key;
  try { return await fn(); } finally { (config as any).secretKey = saved; }
}

test('the check value is written once, then matches the same key and not another', async () => {
  assert.equal(await ensureKeyCheck(pool), 'created');
  assert.equal(await ensureKeyCheck(pool), 'ok');
  assert.equal(await withKey('a-completely-different-secret-key-0123456789', () => ensureKeyCheck(pool)), 'mismatch');
});

test('verifyKey checks every stored secret; the CLI reports and --reset adopts a new key', async () => {
  const { bookId } = await registerUser(base);
  await pool.query(`INSERT INTO institution_links (book_id, provider, access_url_enc, status) VALUES ($1, 'simplefin', $2, 'active')`, [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]);
  await pool.query(`UPDATE books SET rentcast_api_key = $2 WHERE id = $1`, [bookId, 'enc1:' + encryptSecret('rc-key')]);

  const good = await verifyKey(pool);
  assert.equal(good.check, 'ok');
  assert.equal(good.ok, true);
  assert.ok(good.secrets['bank connections'].total >= 1);
  assert.equal(good.secrets['RentCast keys'].failed, 0);

  const out: string[] = [];
  const other = 'a-completely-different-secret-key-0123456789';
  assert.equal(await withKey(other, () => runCli([], pool, (s) => out.push(s))), false);
  assert.match(out.join('\n'), /DOES NOT DECRYPT[\s\S]*FAILED/);

  // --reset adopts the new key for the check value (stored secrets still need the old one).
  await withKey(other, () => runCli(['--reset'], pool, () => {}));
  const after = await withKey(other, () => verifyKey(pool));
  assert.equal(after.check, 'ok');
  assert.equal(after.ok, false, 'secrets saved with the old key still fail');
  await runCli(['--reset'], pool, () => {}); // back to the test key for later tests
});

test('a backup from before the check value existed passes only when it holds secrets that decrypt', async () => {
  // A fake database with no app_meta table and the given stored secrets.
  const fake = (secrets: string[]) => ({
    query: async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ ok: false }] };
      if (sql.includes('FROM books')) return { rows: secrets.map((v) => ({ v })) };
      return { rows: [] };
    },
  });
  const none = await verifyKey(fake([]));
  assert.equal(none.check, 'missing');
  assert.equal(none.ok, false, 'nothing to prove the key with');
  assert.equal((await verifyKey(fake([encryptSecret('rc-key')]))).ok, true);
  assert.equal((await verifyKey(fake(['not:a:secret']))).ok, false);
});
