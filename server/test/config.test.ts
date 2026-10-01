import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// config.ts evaluates its exports once at import time from process.env. To exercise
// both sides of its default-vs-provided and NODE_ENV branches, we re-import it fresh
// with a cache-busting query string after setting the relevant env vars.
//
// NOTE: config.ts also runs dotenv.config() against the repo-root .env, which sets
// (only) vars NOT already present in process.env. So DATABASE_URL/PORT/ANTHROPIC_*/
// RENTCAST_API_KEY are repopulated from .env if we delete them — we therefore assert
// the DEFAULT (undefined) branch only for vars .env does NOT define, and cover the
// "provided" branch for the .env-backed ones by setting them explicitly (which dotenv
// then leaves untouched).
let counter = 0;
async function loadConfig(env: Record<string, string | undefined>) {
  const keys = Object.keys(env);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(`../src/config.js?cfg=${counter++}`);
    return mod as typeof import('../src/config.js');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Vars .env does NOT define — safe to delete and observe the built-in default branch.
const CLEAR_UNSET: Record<string, undefined> = {
  APP_DATABASE_URL: undefined, DB_POOL_MAX: undefined, HOST: undefined,
  API_TOKEN: undefined, WEB_ORIGIN: undefined, COOKIE_SECURE: undefined,
  TRUST_PROXY: undefined, APP_BASE_URL: undefined, APP_SECRET_KEY: undefined,
  NODE_ENV: undefined, SIGNUP_MODE: undefined,
};

describe('config defaults for unset (non-.env) vars', () => {
  it('uses built-in defaults', async () => {
    const { config } = await loadConfig(CLEAR_UNSET);
    // appDatabaseUrl falls back to DATABASE_URL (from .env) since APP_DATABASE_URL unset.
    assert.equal(config.appDatabaseUrl, config.databaseUrl);
    assert.equal(config.dbPoolMax, 20);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.apiToken, '');
    assert.equal(config.webOrigin, '');
    assert.equal(config.appBaseUrl, '');
  });

  it('non-production: cookieSecure/trustProxy off, dev secret fallback', async () => {
    const { config } = await loadConfig({ ...CLEAR_UNSET, NODE_ENV: 'development' });
    assert.equal(config.cookieSecure, false);
    assert.equal(config.trustProxy, false);
    assert.equal(config.secretKey, 'dev-insecure-app-secret-change-me');
    assert.equal(config.signupMode, 'open');
  });
});

describe('config overrides (env set wins over defaults and .env)', () => {
  it('reads provided values', async () => {
    const { config, aiConfigured, rentcastConfigured } = await loadConfig({
      DATABASE_URL: 'postgresql://a@h/admin',
      APP_DATABASE_URL: 'postgresql://b@h/app',
      PORT: '5555',
      DB_POOL_MAX: '42',
      HOST: '0.0.0.0',
      API_TOKEN: 'tok',
      WEB_ORIGIN: 'https://example.com',
      APP_BASE_URL: 'https://app.example.com',
      ANTHROPIC_API_KEY: 'sk-x',
      ANTHROPIC_MODEL: 'claude-custom',
      RENTCAST_API_KEY: 'rc-y',
      APP_SECRET_KEY: 'real-secret',
    });
    assert.equal(config.databaseUrl, 'postgresql://a@h/admin');
    assert.equal(config.appDatabaseUrl, 'postgresql://b@h/app');
    assert.equal(config.port, 5555);
    assert.equal(config.dbPoolMax, 42);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.apiToken, 'tok');
    assert.equal(config.webOrigin, 'https://example.com');
    assert.equal(config.appBaseUrl, 'https://app.example.com');
    assert.equal(config.anthropicModel, 'claude-custom');
    assert.equal(config.secretKey, 'real-secret');
    assert.equal(aiConfigured, true);
    assert.equal(rentcastConfigured, true);
  });

  it('appDatabaseUrl uses APP_DATABASE_URL when set', async () => {
    const { config } = await loadConfig({ APP_DATABASE_URL: 'postgresql://only@h/db' });
    assert.equal(config.appDatabaseUrl, 'postgresql://only@h/db');
  });

  it('aiConfigured/rentcastConfigured are false when keys are blank', async () => {
    const { aiConfigured, rentcastConfigured } = await loadConfig({
      ANTHROPIC_API_KEY: '', RENTCAST_API_KEY: '',
    });
    assert.equal(aiConfigured, false);
    assert.equal(rentcastConfigured, false);
  });

  it('COOKIE_SECURE/TRUST_PROXY explicit overrides win in either NODE_ENV', async () => {
    const on = await loadConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'true', TRUST_PROXY: 'true' });
    assert.equal(on.config.cookieSecure, true);
    assert.equal(on.config.trustProxy, true);

    const off = await loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false', TRUST_PROXY: 'false' });
    assert.equal(off.config.cookieSecure, false);
    assert.equal(off.config.trustProxy, false);
  });

  it('production defaults: cookieSecure/trustProxy on, no insecure secret fallback', async () => {
    const { config } = await loadConfig({ ...CLEAR_UNSET, NODE_ENV: 'production' });
    assert.equal(config.cookieSecure, true);
    assert.equal(config.trustProxy, true);
    assert.equal(config.secretKey, ''); // dev fallback NOT used in production
    assert.equal(config.signupMode, 'invite');
  });

  it('SIGNUP_MODE overrides the default, and an unknown value fails closed to invite', async () => {
    assert.equal((await loadConfig({ ...CLEAR_UNSET, NODE_ENV: 'production', SIGNUP_MODE: 'open' })).config.signupMode, 'open');
    assert.equal((await loadConfig({ ...CLEAR_UNSET, NODE_ENV: 'development', SIGNUP_MODE: 'invite' })).config.signupMode, 'invite');
    assert.equal((await loadConfig({ ...CLEAR_UNSET, NODE_ENV: 'development', SIGNUP_MODE: 'Open ' })).config.signupMode, 'invite');
  });

  it('production with APP_SECRET_KEY set uses it', async () => {
    const { config } = await loadConfig({ NODE_ENV: 'production', APP_SECRET_KEY: 'prod-secret' });
    assert.equal(config.secretKey, 'prod-secret');
  });
});
