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
import { authContext, requireAuth, tenantDb, expectedBook } from './tenant.js';

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
import { properties, runDuePropertyValuesSafe } from './routes/properties.js';
import { liabilities } from './routes/liabilities.js';
import { networth } from './routes/networth.js';
import { goals } from './routes/goals.js';
import { analysis } from './routes/analysis.js';
import { dashboard } from './routes/dashboard.js';
import { connections, syncAllSimplefinLinksSafe } from './routes/connections.js';
import { runDueBackupsSafe } from './routes/backup.js';
import { encryptLegacyAiKeys } from './ai/aiKeys.js';
import { ensureKeyCheck } from './keyCheck.js';
import { integrations } from './routes/integrations.js';
import { receiptItems } from './routes/receiptItems.js';
import { todos } from './routes/todos.js';

const app = express();
// Behind an ALB/reverse proxy, trust the first hop so Secure cookies + req.protocol work.
if (config.trustProxy) app.set('trust proxy', 1);
// Security headers first, so every response carries them — including error
// responses and the SPA's index.html served from web/dist below.
app.use(securityHeaders);
// Cross-origin access. The app serves its own pages and API from one origin (and the
// dev server proxies /api), so by default no other origin is granted access. Set
// WEB_ORIGIN only if the web app is served from a different origin than the API.
app.use(cors(config.webOrigin ? { origin: config.webOrigin, credentials: true } : { origin: false }));

// Reject state-changing requests that a browser marks as coming from another site.
// Browsers send Origin on cross-site (and same-origin) POST/PUT/PATCH/DELETE; a page on
// another site can't forge it, so this blocks cross-site request forgery even from
// sibling (same-site) origins that SameSite=Lax cookies don't separate. Requests
// without an Origin (curl, server-to-server) carry no browser cookies and pass.
function sameOriginForWrites(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host = '';
  try { host = new URL(origin).host; } catch { /* malformed → rejected below */ }
  const allowed = new Set<string>([req.get('host') ?? '']);
  for (const o of [config.webOrigin, config.appBaseUrl]) {
    try { if (o) allowed.add(new URL(o).host); } catch { /* ignore a malformed setting */ }
  }
  if (host && allowed.has(host)) return next();
  next(new HttpError(403, 'This request came from another website and was blocked.'));
}
app.use('/api', sameOriginForWrites);
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
app.use('/api', expectedBook);
app.use('/api', tenantDb);
app.use('/api/books', books);
app.use('/api/imports', imports);
app.use('/api/dashboard', dashboard);
app.use('/api/connections', connections);
app.use('/api/integrations', integrations);
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
  // The client went away before the response (e.g. it navigated on): its database
  // connection was discarded mid-query (see tenantDb), so this error is expected, and
  // there's no one to answer.
  if (res.destroyed || res.writableEnded) return;
  // SQLSTATE DR409: a database guard refused a change with a message written for the
  // user (e.g. editing a reconciled transaction; see migration 129).
  if (err?.code === 'DR409') {
    res.status(409).json({ error: String(err.message) });
    return;
  }
  const isHttpError = err instanceof HttpError;
  const status = isHttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  // An HttpError's message is written for the user (e.g. 503 "AI is not configured…"),
  // so pass it through at any status. Anything else may carry internal/DB error text
  // and is masked.
  const message = isHttpError ? (err.message || 'Error') : 'Internal error';
  res.status(status).json(isHttpError && err.code ? { error: message, code: err.code } : { error: message });
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
    // Encrypt any personal AI keys stored before at-rest encryption.
    const n = await encryptLegacyAiKeys();
    if (n) console.log(`Encrypted ${n} stored personal AI key(s).`);
    // Prove APP_SECRET_KEY still matches this database's secrets (see keyCheck.ts).
    if (await ensureKeyCheck(pool) === 'mismatch') {
      console.error('APP_SECRET_KEY does not decrypt this database\'s stored secrets: bank connections and saved API keys won\'t work. Restore the original key (keep a copy outside the server). If you changed it on purpose, run node dist/keyCheck.js --reset.');
    }
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

    // Automatic property value updates (RentCast), weekly or monthly per property.
    // Each sweep only calls RentCast for properties that are actually due.
    setTimeout(() => { runDuePropertyValuesSafe(); }, 120_000).unref();
    setInterval(() => { runDuePropertyValuesSafe(); }, CHECK_MS).unref();
  });
}
