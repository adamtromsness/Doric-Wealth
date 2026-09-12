import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/rateLimit.js';

// Minimal fake req/res so we can drive the middleware without a real server.
function fakeReq(ip = '1.2.3.4') {
  return { ip } as any;
}
function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    status(code: number) { res.statusCode = code; return res; },
    json(payload: any) { res.body = payload; return res; },
  };
  return res;
}

describe('rateLimit', () => {
  let savedDisable: string | undefined;
  beforeEach(() => {
    savedDisable = process.env.DISABLE_RATE_LIMIT;
    delete process.env.DISABLE_RATE_LIMIT; // exercise the real limiter
  });
  afterEach(() => {
    if (savedDisable === undefined) delete process.env.DISABLE_RATE_LIMIT;
    else process.env.DISABLE_RATE_LIMIT = savedDisable;
  });

  it('allows requests up to the max, then returns 429 with Retry-After', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2 });
    const res1 = fakeRes(); let called1 = false;
    mw(fakeReq(), res1, () => { called1 = true; });
    assert.equal(called1, true);

    const res2 = fakeRes(); let called2 = false;
    mw(fakeReq(), res2, () => { called2 = true; });
    assert.equal(called2, true);

    // Third within the window is blocked.
    const res3 = fakeRes(); let called3 = false;
    mw(fakeReq(), res3, () => { called3 = true; });
    assert.equal(called3, false);
    assert.equal(res3.statusCode, 429);
    assert.ok(res3.headers['retry-after']);
    assert.ok(Number(res3.headers['retry-after']) > 0);
    assert.match(res3.body.error, /Too many attempts/);
  });

  it('uses a custom message when provided', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, message: 'Slow down!' });
    mw(fakeReq(), fakeRes(), () => {});
    const res = fakeRes();
    mw(fakeReq(), res, () => {});
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, 'Slow down!');
  });

  it('keys separately per IP', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    mw(fakeReq('10.0.0.1'), fakeRes(), () => {});
    // A different IP is still allowed on its first hit.
    let called = false;
    mw(fakeReq('10.0.0.2'), fakeRes(), () => { called = true; });
    assert.equal(called, true);
  });

  it('uses keyPrefix so two limiters do not collide', () => {
    const a = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'a:' });
    const b = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'b:' });
    a(fakeReq(), fakeRes(), () => {});
    let called = false;
    b(fakeReq(), fakeRes(), () => { called = true; });
    assert.equal(called, true); // separate stores/keys
  });

  it('handles a request with no ip (falls back to "unknown")', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    let called = false;
    mw({ ip: undefined } as any, fakeRes(), () => { called = true; });
    assert.equal(called, true);
  });

  it('resets after the window expires (sweep + per-key filter)', () => {
    const realNow = Date.now;
    let t = 1_000_000;
    (Date as any).now = () => t;
    try {
      const mw = rateLimit({ windowMs: 1000, max: 1 });
      // First hit at t consumes the budget.
      mw(fakeReq(), fakeRes(), () => {});
      const blocked = fakeRes();
      mw(fakeReq(), blocked, () => {});
      assert.equal(blocked.statusCode, 429);

      // Advance past the window; sweep runs and old hits are filtered out.
      t += 2000;
      let called = false;
      mw(fakeReq(), fakeRes(), () => { called = true; });
      assert.equal(called, true, 'window expiry should allow the request again');
    } finally {
      (Date as any).now = realNow;
    }
  });

  it('opts out entirely when DISABLE_RATE_LIMIT=1', () => {
    process.env.DISABLE_RATE_LIMIT = '1';
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    // Even far past the max, every request calls next().
    for (let i = 0; i < 5; i++) {
      let called = false;
      mw(fakeReq(), fakeRes(), () => { called = true; });
      assert.equal(called, true);
    }
  });
});
