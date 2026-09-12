import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ah, HttpError, require_ } from '../src/http.js';

describe('HttpError', () => {
  it('sets status and message and is an Error', () => {
    const e = new HttpError(404, 'nope');
    assert.ok(e instanceof Error);
    assert.equal(e.status, 404);
    assert.equal(e.message, 'nope');
  });
});

describe('ah (async handler wrapper)', () => {
  it('passes through when the handler resolves', async () => {
    let nextErr: any = 'unset';
    const handler = ah(async (_req, res) => { (res as any).ok = true; });
    const res: any = {};
    await handler({} as any, res, ((e?: any) => { nextErr = e; }) as any);
    assert.equal(res.ok, true);
    assert.equal(nextErr, 'unset'); // next(err) not called on success
  });

  it('forwards a rejected promise to next(err)', async () => {
    const boom = new Error('boom');
    const handler = ah(async () => { throw boom; });
    let captured: any;
    // The wrapper returns fn(...).catch(next); await that chain.
    await (handler({} as any, {} as any, ((e?: any) => { captured = e; }) as any) as any);
    assert.equal(captured, boom);
  });
});

describe('require_', () => {
  it('does not throw when all fields are present', () => {
    assert.doesNotThrow(() => require_({ a: 1, b: 'x', c: false, d: 0 }, ['a', 'b', 'c', 'd']));
  });

  it('throws HttpError(400) listing all missing fields', () => {
    try {
      require_({ a: 1 }, ['a', 'b', 'c']);
      assert.fail('expected throw');
    } catch (e) {
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).status, 400);
      assert.match((e as HttpError).message, /Missing required field\(s\): b, c/);
    }
  });

  it('treats undefined, null, and empty string as missing', () => {
    assert.throws(() => require_({ a: undefined }, ['a']), /a/);
    assert.throws(() => require_({ a: null }, ['a']), /a/);
    assert.throws(() => require_({ a: '' }, ['a']), /a/);
  });

  it('accepts falsy-but-present values (0, false)', () => {
    assert.doesNotThrow(() => require_({ a: 0, b: false }, ['a', 'b']));
  });
});
