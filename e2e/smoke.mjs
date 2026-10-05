// Browser smoke test, part of the release checks (scripts/check.sh, deploy.sh).
//
//   node e2e/smoke.mjs                 full run: starts a throwaway Doric (fresh test
//                                      database, built web app), signs up, uses the
//                                      main pages, and checks two tabs can't write
//                                      into the wrong book. Needs the dev Postgres
//                                      (port 5433) and web/dist (npm run build in web/).
//   node e2e/smoke.mjs --url <base>    read-only run against a deployed server: the
//                                      sign-in and privacy pages load cleanly. Makes no
//                                      changes, so it's safe on real data.
//
// Fails on any page error, failed request (5xx), or missing expected content.
// One-time setup: e2e/setup.sh.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argUrl = (() => { const i = process.argv.indexOf('--url'); return i === -1 ? null : process.argv[i + 1]; })();

function browserPath() {
  const dir = path.join(os.homedir(), '.cache', 'ms-playwright');
  const shells = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort()
      .flatMap((d) => fs.readdirSync(path.join(dir, d)).map((sub) => path.join(dir, d, sub, 'chrome-headless-shell')))
      .filter((p) => fs.existsSync(p))
    : [];
  return process.env.SMOKE_BROWSER || shells.at(-1) || undefined;
}

async function launch() {
  const libs = path.join(os.homedir(), '.cache', 'doric-smoke', 'usr', 'lib', 'x86_64-linux-gnu');
  const env = { ...process.env };
  if (fs.existsSync(libs)) env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  try {
    return await chromium.launch({ executablePath: browserPath(), env });
  } catch (e) {
    throw new Error(`Couldn't start the browser (run e2e/setup.sh once): ${e.message.split('\n')[0]}`);
  }
}

// Record page errors and failed requests on a page, so each step can assert none.
function watch(page, problems) {
  page.on('pageerror', (e) => problems.push(`page error on ${page.url()}: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} from ${r.request().method()} ${r.url()}`); });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(f)) problems.push(`request failed: ${r.method()} ${r.url()} (${f})`);
  });
}

function check(cond, msg) { if (!cond) throw new Error(msg); }
const step = (s) => console.log(`  ✓ ${s}`);

async function readOnly(base) {
  console.log(`Smoke (read-only): ${base}`);
  const ready = await fetch(`${base}/api/ready`);
  check(ready.ok, `/api/ready returned ${ready.status}`);
  step('ready');
  const browser = await launch();
  const problems = [];
  try {
    const page = await browser.newPage();
    watch(page, problems);
    await page.goto(`${base}/login`);
    await page.getByRole('button', { name: 'Sign in' }).waitFor();
    step('sign-in page renders');
    await page.goto(`${base}/privacy`);
    await page.getByRole('heading', { name: 'When data leaves Doric' }).waitFor();
    step('privacy page renders');
  } finally {
    await browser.close();
  }
  check(!problems.length, problems.join('\n'));
}

async function full() {
  check(fs.existsSync(path.join(root, 'web', 'dist', 'index.html')), 'web/dist is missing: run npm run build in web/ first.');
  // node directly (not npx), so SIGTERM reaches the app, which then drops its database.
  const app = spawn(process.execPath, ['--import', 'tsx', 'test/smoke-app.ts'], { cwd: path.join(root, 'server'), stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    app.stdout.on('data', (d) => { out += d; const m = /READY (\S+)/.exec(out); if (m) resolve(m[1]); });
    app.on('exit', (c) => reject(new Error(`the throwaway app exited (${c}) before it was ready`)));
    setTimeout(() => reject(new Error('the throwaway app did not start within 60s')), 60000).unref();
  });
  console.log(`Smoke (full): throwaway app at ${base}`);
  const browser = await launch();
  const problems = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    watch(page, problems);
    // A 401 from /auth/me before signing in is expected; anything else isn't.
    const email = `smoke-${Date.now()}@example.com`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('smoke-password-1');
    await page.getByLabel('Books Name').fill('Smoke Book');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
    step('sign up lands on the dashboard');

    await page.goto(`${base}/accounts/new`);
    await page.getByPlaceholder('Everyday Checking').fill('Smoke Checking');
    await page.getByRole('button', { name: 'Add Account' }).last().click();
    await page.goto(`${base}/accounts`);
    await page.getByText('Smoke Checking').first().waitFor();
    step('add an account');

    for (const [p, title] of [['/transactions', 'Transactions'], ['/budgets', 'Budgets'], ['/book', null], ['/my-data', null], ['/privacy', 'Privacy'], ['/changelog', null]]) {
      await page.goto(`${base}${p}`);
      if (title) await page.getByRole('heading', { name: title, level: 1 }).waitFor();
      else await page.locator('h1').first().waitFor();
    }
    step('main pages render');

    // Two tabs: a book switch in one stops a stale write from the other.
    const stale = await context.newPage();
    watch(stale, problems);
    await stale.goto(`${base}/accounts/new`);
    await stale.getByPlaceholder('Everyday Checking').fill('Stale Tab Account');
    // Creating a book switches to it (this tab's session), like switching in the menu.
    const second = await page.evaluate(async () => {
      const r = await fetch('/api/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second Book' }) });
      return (await r.json()).activeBook?.id ?? 0;
    });
    check(second > 0, 'could not create a second book');
    const refused = stale.waitForResponse((r) => r.url().endsWith('/api/accounts') && r.request().method() === 'POST');
    await stale.getByRole('button', { name: 'Add Account' }).last().click();
    check((await refused).status() === 409, 'a write from the stale tab was not refused');
    const names = await page.evaluate(async () => (await (await fetch('/api/accounts')).json()).map((a) => a.name));
    check(!names.includes('Stale Tab Account'), 'the stale tab wrote into the other book');
    step('a stale tab cannot write into another book');
  } finally {
    await browser.close();
    if (app.exitCode == null) {
      const exited = new Promise((r) => app.once('exit', r));
      app.kill('SIGTERM');
      await exited;
    }
  }
  check(!problems.length, problems.join('\n'));
}

try {
  if (argUrl) await readOnly(argUrl.replace(/\/$/, ''));
  else await full();
  console.log('Smoke test passed.');
} catch (e) {
  console.error(`Smoke test FAILED: ${e.message}`);
  process.exitCode = 1;
}
