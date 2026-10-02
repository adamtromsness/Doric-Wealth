// One-time setup before the integration test files run: (re)create a clean test
// database and apply all migrations. Run via `tsx test/prepare-db.ts`.
import pg from 'pg';
import { TEST_DATABASE_URL, adminUrl, testDbName, assertSafeDbName, RESTRICTED_TEST_ROLE, RESTRICTED_TEST_PASSWORD } from './config.js';
import { applyMigrations } from './helpers.js';

async function main() {
  assertSafeDbName(testDbName);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  const n = await applyMigrations(TEST_DATABASE_URL);

  // The restricted app role (see RESTRICTED_TEST_ROLE): roles are cluster-wide, so
  // create it once and (re)grant on the fresh test database each run.
  const db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  const exists = (await db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [RESTRICTED_TEST_ROLE])).rows[0];
  await db.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${RESTRICTED_TEST_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${RESTRICTED_TEST_PASSWORD}'`);
  await db.query(`GRANT CONNECT ON DATABASE ${testDbName} TO ${RESTRICTED_TEST_ROLE}`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ${RESTRICTED_TEST_ROLE}`);
  await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RESTRICTED_TEST_ROLE}`);
  await db.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RESTRICTED_TEST_ROLE}`);
  await db.end();

  console.log(`Test database "${testDbName}" ready — ${n} migrations applied, restricted role ${RESTRICTED_TEST_ROLE} granted.`);
}

main().catch((e) => {
  console.error('prepare-db failed:', e.message);
  console.error('Is Postgres up? Try: docker compose up -d');
  process.exit(1);
});
