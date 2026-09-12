import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from the repo root (one level up from /server)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Matches docker-compose.yml, which publishes the Postgres container on host port 5433.
const DEFAULT_DB = 'postgresql://finance:finance@localhost:5433/finance';

export const config = {
  // Privileged connection (owner/admin): used for migrations, bootstrap, and the
  // db-role setup script.
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DB,
  // Connection the running server uses for requests. Set this to a NON-superuser
  // role (see `npm run setup:db-role`) so Postgres row-level security is actually
  // enforced — superusers bypass RLS. Falls back to DATABASE_URL when unset (dev).
  appDatabaseUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DB,
  port: Number(process.env.PORT ?? 4000),
  // Max pooled DB connections. Each in-flight authenticated request holds one for
  // its duration (for the per-request RLS connection), so size it above expected
  // concurrency — especially since AI routes can hold a connection for seconds.
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
  // Network interface to bind. Defaults to loopback so the app is not exposed on
  // the LAN unless the operator opts in (set HOST=0.0.0.0, ideally with API_TOKEN).
  host: process.env.HOST ?? '127.0.0.1',
  // Optional shared secret. When set, every /api request must send it as
  // `Authorization: Bearer <token>` or `X-API-Token: <token>`. Unset = open (local use).
  apiToken: process.env.API_TOKEN ?? '',
  // Optional allowed browser origin for CORS. Unset = reflect request origin (dev).
  webOrigin: process.env.WEB_ORIGIN ?? '',
  // Send the session cookie with the Secure flag (HTTPS only). Default on in
  // production; set COOKIE_SECURE=false when developing over plain http.
  cookieSecure: (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
  // Trust the X-Forwarded-* headers from a single upstream proxy (ALB), so Secure
  // cookies and req.protocol work behind TLS termination. On by default in prod.
  trustProxy: (process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
  // Public base URL of the app (e.g. https://ledger.example.com), used to build
  // shareable invite links. Unset = links are returned as a relative /accept path.
  appBaseUrl: process.env.APP_BASE_URL ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  rentcastApiKey: process.env.RENTCAST_API_KEY ?? '',
  // Secret used to encrypt stored third-party credentials (e.g. a linked SimpleFIN
  // access URL) at rest. REQUIRED in production once a connection is created. In
  // development we fall back to an insecure constant so the demo flow works without
  // setup — never rely on this default for real credentials.
  secretKey: process.env.APP_SECRET_KEY ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-insecure-app-secret-change-me'),
};

export const aiConfigured = Boolean(config.anthropicApiKey);
export const rentcastConfigured = Boolean(config.rentcastApiKey);
