import type { Request, Response, NextFunction } from 'express';

// Tiny in-memory sliding-window rate limiter (no deps). Keyed by client IP, which
// is accurate when `trust proxy` is on (set behind the ALB). Note: state is
// per-process, so with >1 instance the effective limit is per-instance — for
// strict global limits across a fleet, back this with a shared store (e.g. Redis).
export function rateLimit(opts: { windowMs: number; max: number; keyPrefix?: string; message?: string }) {
  const store = new Map<string, number[]>();
  let lastSweep = Date.now();

  const sweep = (now: number) => {
    if (now - lastSweep < opts.windowMs) return;
    lastSweep = now;
    for (const [k, arr] of store) {
      const recent = arr.filter((t) => now - t < opts.windowMs);
      if (recent.length) store.set(k, recent);
      else store.delete(k);
    }
  };

  return (req: Request, res: Response, next: NextFunction) => {
    // Opt-out for the integration test suite (many sign-ups per process). Never set
    // in production.
    if (process.env.DISABLE_RATE_LIMIT === '1') return next();
    const now = Date.now();
    sweep(now);
    const key = (opts.keyPrefix ?? '') + (req.ip || 'unknown');
    const hits = (store.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (hits.length >= opts.max) {
      const retryS = Math.ceil((opts.windowMs - (now - hits[0])) / 1000);
      res.setHeader('Retry-After', String(retryS));
      return res.status(429).json({ error: opts.message ?? 'Too many attempts. Please wait and try again.' });
    }
    hits.push(now);
    store.set(key, hits);
    next();
  };
}
