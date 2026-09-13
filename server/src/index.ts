import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, assertProductionConfig } from './config.js';
import { HttpError } from './http.js';
import { pool, assertSafeAppRole } from './db.js';
import { securityHeaders } from './securityHeaders.js';
import { deleteExpiredSessions } from './auth.js';
import { syncAllManagedCategoriesSafe } from './managedCategories.js';
import { authContext, requireAuth, tenantDb } from './tenant.js';

import { auth } from './routes/auth.js';
import { books } from './routes/books.js';
import { invites } from './routes/invites.js';
import { imports } from './routes/imports.js';
import { accounts } from './routes/accounts.js';
import { reconciliations } from './routes/reconciliations.js';
import { categories } from './routes/categories.js';
import { budgets } from './routes/budgets.js';
import { transactions } from './routes/transactions.js';
import { utilities } from './routes/utilities.js';
import { subscriptions } from './routes/subscriptions.js';
import { backup } from './routes/backup.js';
import { reminders } from './routes/reminders.js';
import { tags } from './routes/tags.js';
import { vehicles } from './routes/vehicles.js';
import { assets } from './routes/assets.js';
import { properties } from './routes/properties.js';
import { liabilities } from './routes/liabilities.js';
import { networth } from './routes/networth.js';
import { goals } from './routes/goals.js';
import { analysis } from './routes/analysis.js';
import { dashboard } from './routes/dashboard.js';
import { connections, syncAllSimplefinLinksSafe } from './routes/connections.js';
import { runDueBackupsSafe } from './routes/backup.js';
import { receiptItems } from './routes/receiptItems.js';
import { todos } from './routes/todos.js';

const app = express();
// Behind an ALB/reverse proxy, trust the first hop so Secure cookies + req.protocol work.
if (config.trustProxy) app.set('trust proxy', 1);
// Security headers first, so every response carries them — including error
// responses and the SPA's index.html served from web/dist below.
app.use(securityHeaders);
// CORS must allow credentials so the session cookie is sent cross-origin (dev).
app.use(cors(config.webOrigin ? { origin: config.webOrigin, credentials: true } : { origin: true, credentials: true }));
// Liveness/readiness probes stay open (no auth, no token) — registered before the
// API-token guard and body parsers so orchestrators can probe cheaply.
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/ready', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

// Constant-time string compare (avoids leaking the token via response timing).
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// When API_TOKEN is configured, every /api request (except the probes above) must
// present it as `Authorization: Bearer <token>` or `X-API-Token: <token>`. Mounted
// BEFORE the body parsers so an unauthenticated request is rejected before its
// (possibly large) body is read. Unset = open (local use).
function apiTokenGuard(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (!config.apiToken) return next();
  const authz = req.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authz)?.[1]?.trim() ?? '';
  const presented = bearer || (req.get('x-api-token') ?? '').trim();
  if (presented && tokensMatch(presented, config.apiToken)) return next();
  next(new HttpError(401, 'Invalid or missing API token.'));
}
app.use('/api', apiTokenGuard);

// Resolve the session cookie into req.user / req.book for every request. This
// runs BEFORE the body parsers (it reads only the cookie, not the body) so the large
// upload parsers below can be gated on requireAuth — otherwise, when API_TOKEN is
// unset and only session auth protects the app, an unauthenticated request could make
// the server buffer a multi-megabyte body before auth ran.
app.use(authContext);

// Body parsers — large limit only for the upload routes (base64 images/PDFs);
// everything else keeps a small body cap. The upload routes are all authenticated, so
// gate each with requireAuth ahead of its parser: an unauthenticated caller is rejected
// (401) before the big body is read. (The token guard above already covers the
// API_TOKEN-configured case; this protects the session-only case too.)
const bigJson = express.json({ limit: '25mb' });
const hugeJson = express.json({ limit: '200mb' });
app.use('/api/transactions', requireAuth, bigJson);
app.use('/api/utilities', requireAuth, bigJson);
app.use('/api/imports', requireAuth, bigJson);
app.use('/api/properties', requireAuth, bigJson);
app.use('/api/vehicles', requireAuth, bigJson);
app.use('/api/subscriptions', requireAuth, bigJson);
app.use('/api/backup', requireAuth, hugeJson);
app.use(express.json({ limit: '256kb' }));

// Auth + invite-preview endpoints are reachable without an active session.
app.use('/api/auth', auth);
app.use('/api/invites', invites);

// Everything else under /api requires a logged-in user, and runs on a
// book-bound DB connection so row-level security applies.
app.use('/api', requireAuth);
app.use('/api', tenantDb);
app.use('/api/books', books);
app.use('/api/imports', imports);
app.use('/api/dashboard', dashboard);
app.use('/api/connections', connections);
app.use('/api/accounts', accounts);
app.use('/api/reconciliations', reconciliations);
app.use('/api/categories', categories);
app.use('/api/budgets', budgets);
app.use('/api/transactions', transactions);
app.use('/api/utilities', utilities);
app.use('/api/subscriptions', subscriptions);
app.use('/api/backup', backup);
app.use('/api/reminders', reminders);
app.use('/api/todos', todos);
app.use('/api/tags', tags);
app.use('/api/vehicles', vehicles);
app.use('/api/assets', assets);
app.use('/api/properties', properties);
app.use('/api/liabilities', liabilities);
app.use('/api/networth', networth);
app.use('/api/goals', goals);
app.use('/api/analysis', analysis);
app.use('/api/receipt-items', receiptItems);

// Serve the built frontend in production (web/dist), if present.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Centralized error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  // Don't leak internal/DB error text to clients on 500s.
  const message = status >= 500 ? 'Internal error' : (err.message ?? 'Error');
  res.status(status).json({ error: message });
});

// The configured Express app, exported so integration tests can mount it on an
// ephemeral port (they set SERVER_NO_LISTEN=1 to skip the listen below).
export { app };

if (process.env.SERVER_NO_LISTEN !== '1') {
  // Fail closed BEFORE binding: never serve requests with a DB role that can bypass
  // row-level security in production (see assertSafeAppRole).
  try {
    assertProductionConfig();
    await assertSafeAppRole();
  } catch (e: any) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
  app.listen(config.port, config.host, () => {
    console.log(`API listening on http://${config.host}:${config.port}`);
    if (config.host !== '127.0.0.1' && !config.cookieSecure) {
      console.warn('Warning: bound beyond loopback without COOKIE_SECURE — session cookies are sent over plain HTTP. Terminate TLS and set COOKIE_SECURE=true in production.');
    }
    if (!config.anthropicApiKey) {
      console.log('Note: ANTHROPIC_API_KEY not set — AI analysis endpoints will return 503 until you add it to .env');
    }
    // Backfill/refresh the auto-managed categories on boot (every book).
    syncAllManagedCategoriesSafe();

    // Sweep expired sessions on boot and daily thereafter. They were already
    // refused at read time, but nothing deleted them, so the table grew forever
    // and kept stale token hashes on disk.
    const sweepSessions = () => {
      deleteExpiredSessions().catch((e) => console.error('Expired-session sweep failed:', e?.message ?? e));
    };
    sweepSessions();
    setInterval(sweepSessions, 24 * 60 * 60 * 1000).unref();

    // Check the SimpleFIN auto-import schedule periodically. The check is cheap and only
    // syncs connections that are actually due for their start-time + frequency (see
    // syncBookLinks), so a frequent interval lets the schedule fire near each
    // connection's chosen time-of-day. Fires ~1 min after boot, then every 30 min;
    // unref'd so it never holds the process open.
    const CHECK_MS = 30 * 60 * 1000;
    setTimeout(() => { syncAllSimplefinLinksSafe(); }, 60_000).unref();
    setInterval(() => { syncAllSimplefinLinksSafe(); }, CHECK_MS).unref();

    // Scheduled book data backups: same cheap "is it due?" check on the same
    // cadence as the SimpleFIN sweep; only books past their start anchor and
    // overdue for the current period are actually backed up (see runDueBackupsSafe).
    setTimeout(() => { runDueBackupsSafe(); }, 90_000).unref();
    setInterval(() => { runDueBackupsSafe(); }, CHECK_MS).unref();
  });
}
