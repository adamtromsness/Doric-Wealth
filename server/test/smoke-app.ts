// A throwaway Doric for the browser smoke test (e2e/smoke.mjs): a fresh database on
// the test Postgres, migrated, and the server on a free port serving the built web app
// (web/dist). Prints "READY <url>" once it answers; on SIGTERM/SIGINT it stops the
// server and drops the database. Never touches real data.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, dropDatabase, applyMigrations } from './helpers.js';

const DB = 'finance_test_smoke';
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = await createDatabase(DB);
await applyMigrations(url);
const port = 43000 + Math.floor(Math.random() * 2000);
// node directly (not npx), so stopping it stops the server itself.
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: serverRoot,
  env: {
    ...process.env, DATABASE_URL: url, APP_DATABASE_URL: url, PORT: String(port), HOST: '127.0.0.1',
    SIGNUP_MODE: 'open', SERVER_NO_LISTEN: '', ANTHROPIC_API_KEY: '', RENTCAST_API_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  child.kill();
  await dropDatabase(DB).catch((e) => console.error('smoke-app: could not drop the database:', e.message));
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => { if (!stopping) { console.error(`smoke-app: server exited (${code})`); void stop(); } });

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 150; i++) {
  try { if ((await fetch(`${base}/api/ready`)).ok) { console.log(`READY ${base}`); break; } } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}
