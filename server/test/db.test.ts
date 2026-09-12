import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';
import { query, one, withTransaction, pool, requestStore, assertSafeAppRole } from '../src/db.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

describe('query / one (pool path, no bound request connection)', () => {
  it('query returns rows', async () => {
    const rows = await query<{ n: number }>('SELECT 1 AS n');
    assert.deepEqual(rows, [{ n: 1 }]);
  });

  it('query returns [] when no rows match', async () => {
    const rows = await query('SELECT 1 WHERE false');
    assert.deepEqual(rows, []);
  });

  it('query passes parameters', async () => {
    const rows = await query<{ v: number }>('SELECT $1::int AS v', [7]);
    assert.equal(rows[0].v, 7);
  });

  it('one returns the first row', async () => {
    const r = await one<{ n: number }>('SELECT 42 AS n');
    assert.deepEqual(r, { n: 42 });
  });

  it('one returns null when there are no rows', async () => {
    const r = await one('SELECT 1 WHERE false');
    assert.equal(r, null);
  });

  it('NUMERIC comes back as a JS number (type parser 1700)', async () => {
    const r = await one<{ m: number }>("SELECT 12.34::numeric AS m");
    assert.equal(r!.m, 12.34);
    assert.equal(typeof r!.m, 'number');
  });
});

describe('withTransaction', () => {
  it('commits on success using a fresh pooled connection (no bound request)', async () => {
    const result = await withTransaction(async (client) => {
      const r = await client.query('SELECT 100 AS v');
      return r.rows[0].v;
    });
    assert.equal(result, 100);
  });

  it('rolls back and rethrows on error (pool path)', async () => {
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query('SELECT 1');
        throw new Error('boom');
      }),
      /boom/
    );
    // Pool is still usable after a rolled-back transaction.
    assert.equal((await one<{ ok: number }>('SELECT 1 AS ok'))!.ok, 1);
  });

  it('uses the bound request connection when one is present (commit path)', async () => {
    const client = await pool.connect();
    try {
      const value = await requestStore.run({ client }, async () => {
        return withTransaction(async (c) => {
          assert.equal(c, client, 'transaction should run on the bound connection');
          const r = await c.query('SELECT 55 AS v');
          return r.rows[0].v;
        });
      });
      assert.equal(value, 55);
    } finally {
      client.release();
    }
  });

  it('rolls back on the bound request connection (error path)', async () => {
    const client = await pool.connect();
    try {
      await requestStore.run({ client }, async () => {
        await assert.rejects(
          withTransaction(async () => { throw new Error('bound-boom'); }),
          /bound-boom/
        );
      });
      // Connection recovered (ROLLBACK ran), so it can still query.
      const r = await client.query('SELECT 1 AS ok');
      assert.equal(r.rows[0].ok, 1);
    } finally {
      client.release();
    }
  });

  it('query/one use the bound connection inside requestStore', async () => {
    const client = await pool.connect();
    try {
      const v = await requestStore.run({ client }, async () => {
        const r = await one<{ n: number }>('SELECT 9 AS n');
        return r!.n;
      });
      assert.equal(v, 9);
    } finally {
      client.release();
    }
  });
});

describe('assertSafeAppRole', () => {
  it('does not throw in the (non-production) test environment', async () => {
    // Test DB uses the finance superuser role; in non-prod this only warns, never throws.
    await assert.doesNotThrow(async () => { await assertSafeAppRole(); });
  });
});

describe('end-to-end: helpers exercise query/one/withTransaction via routes', () => {
  it('a registered user can create and read tenant-scoped rows', async () => {
    const { client } = await registerUser(base);
    const acct = (await client.post('/api/accounts', { name: 'X', type: 'checking' })).body.id;
    assert.ok(acct);
    assert.equal((await client.get(`/api/accounts/${acct}`)).status, 200);
  });
});
