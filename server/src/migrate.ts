import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');

// Migrations run as the privileged role (DDL), never the restricted app role.
const pool = new pg.Pool({ connectionString: config.databaseUrl });

// Migrations numbered at or below this are the pre-ledger baseline. On a database
// that already has the app schema but no ledger (i.e. it was migrated before the
// ledger existed), these historical files are recorded as already-applied rather
// than re-run — not all of them are safe to re-execute against the current schema
// (e.g. a backfill that references a since-renamed column). Fresh databases have no
// existing schema, so nothing is baselined and every file runs from 001.
const BASELINE_THROUGH = '097';

// A ledger of applied migrations, so each file runs exactly once instead of being
// re-executed on every boot (which previously made correctness hinge on every file
// staying perfectly idempotent forever).
async function ensureLedger(client: pg.PoolClient, files: string[]): Promise<Set<string>> {
  const ledgerExisted = (await client.query(`SELECT to_regclass('public.schema_migrations') AS r`)).rows[0].r != null;
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  // First time creating the ledger on an already-populated DB → baseline the
  // historical files so they aren't dangerously re-run.
  if (!ledgerExisted) {
    const populated = (await client.query(`SELECT to_regclass('public.accounts') AS r`)).rows[0].r != null;
    if (populated) {
      const baseline = files.filter((f) => f.slice(0, 3) <= BASELINE_THROUGH);
      for (const f of baseline) {
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
      }
      console.log(`Baselined ${baseline.length} pre-existing migrations (<= ${BASELINE_THROUGH}).`);
    }
  }
  const rows = await client.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
  return new Set(rows.rows.map((r) => r.filename));
}

async function run() {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    const applied = await ensureLedger(client, files);

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      // Each file applies atomically: a failure partway through rolls the whole
      // file back instead of leaving the schema half-migrated.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
        await client.query('COMMIT');
        console.log('done');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    console.log('All migrations applied.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
