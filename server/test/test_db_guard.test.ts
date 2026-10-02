// The destructive test setup (DROP DATABASE … WITH FORCE) must only ever hit a test
// database on a local server. Pure checks: nothing here touches a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeDbName, assertSafeTestHost } from './config.js';

test('only finance_test* database names are accepted', () => {
  for (const ok of ['finance_test', 'finance_test_seed', 'finance_test_signup_empty']) assert.equal(assertSafeDbName(ok), ok);
  for (const bad of ['finance', 'doric', 'postgres', 'finance_testing', 'my_finance_test', 'Finance_Test']) {
    assert.throws(() => assertSafeDbName(bad), /must start with "finance_test"/, bad);
  }
  assert.throws(() => assertSafeDbName('finance_test; DROP TABLE x'), /Unsafe/);
});

test('destructive setup is local-only unless explicitly allowed', () => {
  for (const url of ['postgresql://u:p@localhost:5433/finance_test', 'postgresql://u:p@127.0.0.1/finance_test', 'postgresql://u:p@[::1]:5432/finance_test']) {
    assert.doesNotThrow(() => assertSafeTestHost(url, {}), url);
  }
  const remote = 'postgresql://u:p@prod-db.example.com:5432/finance_test';
  assert.throws(() => assertSafeTestHost(remote, {}), /non-local host "prod-db.example.com"/);
  assert.doesNotThrow(() => assertSafeTestHost(remote, { ALLOW_REMOTE_TEST_DB: '1' }));
});
