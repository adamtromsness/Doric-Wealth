// tenantDb's connection lifecycle, with a fake pool client: a request's connection must
// never be reused while that request's code can still run.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AsyncResource } from 'node:async_hooks';
import { pool, query, ReleasedConnectionError } from '../src/db.js';
import { tenantDb } from '../src/tenant.js';

const realConnect = pool.connect.bind(pool);
afterEach(() => { (pool as any).connect = realConnect; });

function fakeClient(opts: { failReset?: boolean } = {}) {
  const c = {
    queries: [] as string[],
    released: [] as any[],
    query: async (sql: string) => {
      c.queries.push(sql);
      if (opts.failReset && sql === 'RESET ALL') throw new Error('connection broken');
      return { rows: [{ ok: 1 }] };
    },
    release: (arg?: any) => { c.released.push(arg === undefined ? 'returned' : arg === true ? 'discarded' : 'discarded-after-error'); },
  };
  return c;
}

// Run tenantDb for a fake request; resolves with the res emitter and the fake client
// once the handler (next) is running inside the request's binding.
async function startRequest(client: ReturnType<typeof fakeClient>) {
  (pool as any).connect = async () => client;
  const res = Object.assign(new EventEmitter(), { writableFinished: false });
  let handler!: () => Promise<any>;
  const inHandler = new Promise<void>((resolve) => {
    tenantDb({ book: { id: 7 }, user: { id: 3 } } as any, res as any, () => {
      // Bound to this request's async context, like a real route handler's code.
      handler = AsyncResource.bind(() => query('SELECT 1'));
      resolve();
    });
  });
  await inHandler;
  return { res, run: () => handler() };
}

test('an aborted request discards its connection, and its code can no longer query', async () => {
  const client = fakeClient();
  const { res, run } = await startRequest(client);
  await run(); // works while the request is live
  res.emit('close'); // client went away before the response finished
  assert.deepEqual(client.released, ['discarded'], 'not returned to the pool for reuse');
  await assert.rejects(run(), ReleasedConnectionError);
  assert.ok(!client.queries.includes('RESET ALL'));
});

test('a finished request resets its tenant settings and returns the connection to the pool', async () => {
  const client = fakeClient();
  const { res, run } = await startRequest(client);
  res.writableFinished = true;
  res.emit('finish');
  res.emit('close'); // 'close' also fires after 'finish': released once only
  await new Promise((r) => setImmediate(r));
  assert.ok(client.queries.includes('RESET ALL'));
  assert.deepEqual(client.released, ['returned']);
  await assert.rejects(run(), ReleasedConnectionError, 'post-response queries fail too');
});

test('if resetting the connection fails, it is discarded rather than returned', async () => {
  const client = fakeClient({ failReset: true });
  const { res } = await startRequest(client);
  res.writableFinished = true;
  res.emit('finish');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(client.released, ['discarded-after-error']);
});
