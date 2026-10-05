// Proves APP_SECRET_KEY decrypts this database's stored secrets. A known value
// encrypted with the key is kept in app_meta ('secret_key_check'), written on first
// boot, so there's always something to check even before anyone links a bank or saves
// an API key. On boot a mismatch is logged loudly (the key changed, or the database
// came from another server). The restore drill runs the CLI against a restored copy.
//
// CLI (operator):
//   node dist/keyCheck.js            # check the key and every stored secret; exit 1 on failure
//   node dist/keyCheck.js --reset    # after changing APP_SECRET_KEY on purpose
import pg from 'pg';
import { config } from './config.js';
import { encryptSecret, decryptSecret } from './secrets.js';

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };
const CHECK_KEY = 'secret_key_check';
const CHECK_VALUE = 'doric-secret-key-check';

const decrypts = (blob: string): boolean => {
  try { return decryptSecret(blob) !== undefined; } catch { return false; }
};

// Boot: write the check value if missing; report whether the current key matches it.
export async function ensureKeyCheck(db: Queryable): Promise<'created' | 'ok' | 'mismatch'> {
  const row = (await db.query(`SELECT value FROM app_meta WHERE key = $1`, [CHECK_KEY])).rows[0];
  if (!row) {
    await db.query(`INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [CHECK_KEY, encryptSecret(CHECK_VALUE)]);
    return 'created';
  }
  try { return decryptSecret(row.value) === CHECK_VALUE ? 'ok' : 'mismatch'; } catch { return 'mismatch'; }
}

export interface KeyReport { check: 'ok' | 'missing' | 'mismatch'; secrets: Record<string, { total: number; failed: number }>; ok: boolean }

// Check the key against the check value and every stored secret.
export async function verifyKey(db: Queryable): Promise<KeyReport> {
  // A backup from before migration 134 has no app_meta table.
  const hasMeta = (await db.query(`SELECT to_regclass('public.app_meta') IS NOT NULL AS ok`)).rows[0].ok;
  const row = hasMeta ? (await db.query(`SELECT value FROM app_meta WHERE key = $1`, [CHECK_KEY])).rows[0] : undefined;
  let check: KeyReport['check'] = 'missing';
  if (row) { try { check = decryptSecret(row.value) === CHECK_VALUE ? 'ok' : 'mismatch'; } catch { check = 'mismatch'; } }
  const sources: [string, string][] = [
    ['bank connections', `SELECT access_url_enc AS v FROM institution_links WHERE access_url_enc IS NOT NULL`],
    ['personal AI keys', `SELECT substr(ai_api_key, 6) AS v FROM users WHERE ai_api_key LIKE 'enc1:%'`],
    ['RentCast keys', `SELECT substr(rentcast_api_key, 6) AS v FROM books WHERE rentcast_api_key LIKE 'enc1:%'`],
  ];
  const secrets: KeyReport['secrets'] = {};
  for (const [name, sql] of sources) {
    const rows = (await db.query(sql)).rows;
    secrets[name] = { total: rows.length, failed: rows.filter((r) => !decrypts(r.v)).length };
  }
  // A backup from before the check value existed passes if it holds secrets and they
  // all decrypt; with neither, there's nothing to prove the key with.
  const stored = Object.values(secrets).reduce((n, s) => n + s.total, 0);
  const ok = (check === 'ok' || (check === 'missing' && stored > 0)) && Object.values(secrets).every((s) => s.failed === 0);
  return { check, secrets, ok };
}

export async function runCli(argv: string[], db: Queryable, log: (s: string) => void = console.log): Promise<boolean> {
  if (argv.includes('--reset')) {
    await db.query(
      `INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [CHECK_KEY, encryptSecret(CHECK_VALUE)]
    );
    log('Key check reset to the current APP_SECRET_KEY.');
    return true;
  }
  const r = await verifyKey(db);
  log(`APP_SECRET_KEY check value: ${r.check === 'ok' ? 'decrypts' : r.check === 'missing' ? 'MISSING (start the server once to write it)' : 'DOES NOT DECRYPT'}`);
  for (const [name, s] of Object.entries(r.secrets)) log(`  ${name}: ${s.total - s.failed} of ${s.total} decrypt`);
  log(r.ok ? 'OK: this APP_SECRET_KEY recovers the stored secrets.' : 'FAILED: this APP_SECRET_KEY does not recover the stored secrets.');
  return r.ok;
}

if (process.argv[1] && /keyCheck\.(ts|js)$/.test(process.argv[1])) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  runCli(process.argv.slice(2), pool)
    .then((ok) => { if (!ok) process.exitCode = 1; })
    .catch((err) => { console.error(`key-check: ${err.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
