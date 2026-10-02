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

// Guard for every destructive step (DROP/CREATE DATABASE … WITH FORCE). Names are
// interpolated into SQL (it can't be parameterized), so only plain identifiers, and
// they must look like a test database: start with "finance_test" (finance_test,
// finance_test_seed, …). A mistaken TEST_DATABASE_URL pointing at a real database
// (e.g. "finance" or "doric") is refused before anything is dropped.
const SAFE_DB = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TEST_DB = /^finance_test(_[a-z0-9_]+)?$/;
export function assertSafeDbName(name: string): string {
  if (!SAFE_DB.test(name)) throw new Error(`Unsafe test database name: ${name}`);
  if (!TEST_DB.test(name)) {
    throw new Error(`Refusing to use "${name}" as a test database: test database names must start with "finance_test" (e.g. finance_test, finance_test_seed).`);
  }
  return name;
}

// Destructive setup also only runs against a local Postgres unless explicitly allowed
// (CI's service container is localhost; set ALLOW_REMOTE_TEST_DB=1 for anything else).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function assertSafeTestHost(url: string, env: Record<string, string | undefined> = process.env): void {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && env.ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`Refusing destructive test setup on non-local host "${host}". Set ALLOW_REMOTE_TEST_DB=1 if that's really a test server.`);
  }
}
assertSafeDbName(testDbName);
assertSafeTestHost(TEST_DATABASE_URL);

// A restricted (non-superuser, NOBYPASSRLS) role, like production's app role, so tests
// can run the app with row-level security actually enforced. prepare-db creates it.
// Opt in per test file (or the whole suite) with TEST_RESTRICTED_ROLE=1.
export const RESTRICTED_TEST_ROLE = 'finance_test_app';
export const RESTRICTED_TEST_PASSWORD = 'finance_test_app';
export function restrictedTestUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = RESTRICTED_TEST_ROLE;
  u.password = RESTRICTED_TEST_PASSWORD;
  return u.toString();
}
