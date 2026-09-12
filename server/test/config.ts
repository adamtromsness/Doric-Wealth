// Test database connection config (no side effects — safe to import anywhere).
// Tests run against a dedicated database on the docker-compose Postgres so they
// never touch a developer's real data. Override with TEST_DATABASE_URL for CI.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://finance:finance@localhost:5433/finance_test';

export function swapDbUrl(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = '/' + db;
  return u.toString();
}

export const testDbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
// A maintenance connection (to create/drop databases) — can't be connected to the
// database it is dropping, so use the always-present `postgres` database.
export const adminUrl = swapDbUrl(TEST_DATABASE_URL, 'postgres');

// Guard: database names are interpolated into CREATE/DROP DATABASE (which can't be
// parameterized), so only allow plain identifiers.
const SAFE_DB = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export function assertSafeDbName(name: string): string {
  if (!SAFE_DB.test(name)) throw new Error(`Unsafe test database name: ${name}`);
  return name;
}
assertSafeDbName(testDbName);
