// One-time setup before the integration test files run: (re)create a clean test
// database and apply all migrations. Run via `tsx test/prepare-db.ts`.
import pg from 'pg';
import { TEST_DATABASE_URL, adminUrl, testDbName, assertSafeDbName } from './config.js';
import { applyMigrations } from './helpers.js';

async function main() {
  assertSafeDbName(testDbName);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  const n = await applyMigrations(TEST_DATABASE_URL);
  console.log(`Test database "${testDbName}" ready — ${n} migrations applied.`);
}

main().catch((e) => {
  console.error('prepare-db failed:', e.message);
  console.error('Is Postgres up? Try: docker compose up -d');
  process.exit(1);
});
