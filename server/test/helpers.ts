// Integration-test harness. Importing this module configures the environment so
// that when the Express app is later imported it talks to the test database and
// does NOT bind its own port (the harness mounts it on an ephemeral port instead).
import { TEST_DATABASE_URL, adminUrl, assertSafeDbName, swapDbUrl } from './config.js';

// Must be set BEFORE the app (and its config/db modules) are imported.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_DATABASE_URL = TEST_DATABASE_URL;
process.env.COOKIE_SECURE = 'false';
process.env.HOST = '127.0.0.1';
process.env.SERVER_NO_LISTEN = '1';
// Tests register many users per process; the auth limiter would otherwise 429.
process.env.DISABLE_RATE_LIMIT = '1';

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const migrationsDir = path.resolve(serverRoot, 'migrations');

// ── In-process server (mounted on a random free port; closed cleanly) ──────────
let server: Server | undefined;
let baseUrl: string | undefined;

export async function startServer(): Promise<string> {
  if (baseUrl) return baseUrl;
  const mod = await import('../src/index.js'); // tsx resolves to src/index.ts
  const app = (mod as any).app;
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  const { port } = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

export async function stopServer(): Promise<void> {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  baseUrl = undefined;
}

// ── HTTP client (cookie jar + optional API token from env) ─────────────────────
export interface ApiResponse { status: number; body: any; headers: Headers; }
export interface Client {
  cookie: string;
  raw(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  get(path: string): Promise<ApiResponse>;
  post(path: string, body?: unknown): Promise<ApiResponse>;
  put(path: string, body?: unknown): Promise<ApiResponse>;
  del(path: string): Promise<ApiResponse>;
}

export function makeClient(base: string): Client {
  let cookie = '';
  const raw = async (method: string, p: string, body?: unknown): Promise<ApiResponse> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.API_TOKEN) headers['x-api-token'] = process.env.API_TOKEN;
    if (cookie) headers['cookie'] = cookie;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = (res.headers as any).getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((c: string) => c.split(';')[0]).join('; ');
    let json: any = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  return {
    get cookie() { return cookie; },
    set cookie(c: string) { cookie = c; },
    raw,
    get: (p) => raw('GET', p),
    post: (p, b) => raw('POST', p, b),
    put: (p, b) => raw('PUT', p, b),
    del: (p) => raw('DELETE', p),
  };
}

// ── User / book helpers ───────────────────────────────────────────────────
let counter = 0;
export function uniqueEmail(prefix = 'u'): string {
  return `${prefix}-${Date.now().toString(36)}-${counter++}@test.local`;
}

export interface RegisteredUser { client: Client; email: string; me: any; bookId: number; }

// Register a fresh user (each gets its own book, so tests are isolated by
// tenancy without any shared-state cleanup). The returned client is logged in.
export async function registerUser(base: string, opts: { email?: string; name?: string; book_name?: string } = {}): Promise<RegisteredUser> {
  const client = makeClient(base);
  const email = opts.email ?? uniqueEmail();
  const r = await client.post('/api/auth/register', {
    email, password: 'supersecret', name: opts.name, book_name: opts.book_name ?? 'Test Book',
  });
  if (r.status !== 201) throw new Error(`register failed (${r.status}): ${JSON.stringify(r.body)}`);
  return { client, email, me: r.body, bookId: r.body.activeBook.id };
}

export async function login(base: string, email: string, password = 'supersecret'): Promise<Client> {
  const client = makeClient(base);
  const r = await client.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed (${r.status})`);
  return client;
}

// ── Raw DB access (for assertions on the test database) ────────────────────────
export function testDbClient(url = TEST_DATABASE_URL): pg.Client {
  return new pg.Client({ connectionString: url });
}

// ── Ephemeral databases (for the destructive fresh-setup/seed test) ────────────
export async function createDatabase(name: string): Promise<string> {
  assertSafeDbName(name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return swapDbUrl(TEST_DATABASE_URL, name);
}

export async function dropDatabase(name: string): Promise<void> {
  assertSafeDbName(name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

// Apply every migration (in order) to a database via a direct connection.
export async function applyMigrations(url: string): Promise<number> {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  await db.end();
  return files.length;
}

// Run a server script (e.g. src/seed.ts) as a child process against a given DB.
export function runScript(relPath: string, dbUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', relPath], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: dbUrl, APP_DATABASE_URL: dbUrl },
      stdio: 'ignore',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${relPath} exited ${code}`))));
    child.on('error', reject);
  });
}
