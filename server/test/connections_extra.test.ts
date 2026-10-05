import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser, testDbClient, setExternalFetch } from './helpers.js';
import { encryptSecret } from '../src/secrets.js';
import { upsertAccountLinks, markAbsentLinks, syncAllSimplefinLinksSafe, applySimplefinSync } from '../src/routes/connections.js';

// An allowed SimpleFIN host: the test harness blocks real outside requests, so the
// fetch fails like an unreachable server and the network-error branches run.
const DEAD_URL = 'https://bridge.simplefin.org/simplefin-unreachable';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Insert an institution_link + account_link directly (no network) so the DB-only
// branches of the connection routes can be exercised deterministically.
async function seedLink(bookId: number, opts: {
  externalId?: string; accountId?: number | null; name?: string; balance?: number | null;
  accessUrl?: string; autoImport?: boolean; autoImportEnabled?: boolean; currency?: string;
} = {}) {
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status, auto_import_enabled, auto_import_frequency, auto_import_start_at)
       VALUES ($1, 'simplefin', $2, 'active', $3, 'daily', now() - interval '2 days') RETURNING id`,
      [bookId, encryptSecret(opts.accessUrl ?? 'https://u:p@bridge.simplefin.org/simplefin'), opts.autoImportEnabled ?? false]
    )).rows[0];
    const ext = opts.externalId ?? 'ext-1';
    await db.query(
      `INSERT INTO account_links (book_id, link_id, external_account_id, name, org_name, currency, account_id, auto_import, last_balance, last_balance_date)
       VALUES ($1,$2,$3,$4,'Test Bank',$9,$5,$6,$7, to_timestamp($8))`,
      [bookId, link.id, ext, opts.name ?? 'SF Checking', opts.accountId ?? null, opts.autoImport ?? false, opts.balance ?? null, opts.balance != null ? 1700000000 : null, opts.currency ?? 'USD']
    );
    return { linkId: link.id as number, externalId: ext };
  } finally {
    await db.end();
  }
}

// ── Auth: all routes are owner/admin-only (requireManager → 403 for members) ──
test('connection routes are manager-only (a plain member gets 403)', async () => {
  const owner = await registerUser(base);
  // Invite a member (default role) and have them switch into the owner's book.
  const code = (await owner.client.post(`/api/books/${owner.bookId}/invites`, {})).body.code;
  const member = await registerUser(base);
  await member.client.post(`/api/invites/${encodeURIComponent(code)}/accept`);
  await member.client.post('/api/books/switch', { book_id: owner.bookId });

  // A member can read the list (no requireManager on GET /), but not mutate.
  assert.equal((await member.client.get('/api/connections')).status, 200);
  assert.equal((await member.client.post('/api/connections/simplefin/claim', { setupToken: 'x' })).status, 403);
  assert.equal((await member.client.post('/api/connections/1/map', {})).status, 403);
  assert.equal((await member.client.post('/api/connections/1/sync', {})).status, 403);
  assert.equal((await member.client.post('/api/connections/1/refresh', {})).status, 403);
  assert.equal((await member.client.post('/api/connections/1/settings', {})).status, 403);
  assert.equal((await member.client.post('/api/connections/import', {})).status, 403);
  assert.equal((await member.client.del('/api/connections/1')).status, 403);
});

// ── Claim: missing token → 400; a token pointing at a private/non-https host → 400 ──
test('claim validates the setup token before any network call', async () => {
  const { client } = await registerUser(base);
  // Empty token.
  assert.equal((await client.post('/api/connections/simplefin/claim', {})).status, 400);
  assert.equal((await client.post('/api/connections/simplefin/claim', { setupToken: '   ' })).status, 400);

  // A token that base64-decodes to an http (non-https) URL → 400 from the SSRF guard.
  const httpToken = Buffer.from('http://example.com/claim').toString('base64');
  assert.equal((await client.post('/api/connections/simplefin/claim', { setupToken: httpToken })).status, 400);

  // A token decoding to a private address → 400.
  const privToken = Buffer.from('https://127.0.0.1/claim').toString('base64');
  assert.equal((await client.post('/api/connections/simplefin/claim', { setupToken: privToken })).status, 400);
});

// ── List connections with their external accounts ────────────────────────────
test('GET / lists connections with nested external accounts', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId, externalId } = await seedLink(bookId);
  const list = (await client.get('/api/connections')).body;
  const conn = list.find((l: any) => l.id === linkId);
  assert.ok(conn, 'the seeded connection is listed');
  assert.equal(conn.provider, 'simplefin');
  assert.ok(conn.accounts.some((a: any) => a.external_account_id === externalId));
});

// ── Map external → internal accounts ─────────────────────────────────────────
test('map: 404 on unknown link, 404 on foreign account, maps + unmaps', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  const { linkId, externalId } = await seedLink(bookId);

  // Unknown link → 404.
  assert.equal((await client.post('/api/connections/999999/map', { mappings: [] })).status, 404);

  // Mapping to an account from another book → 404.
  const other = await registerUser(base);
  const foreign = (await other.client.post('/api/accounts', { name: 'X', type: 'checking' })).body.id;
  assert.equal((await client.post(`/api/connections/${linkId}/map`, { mappings: [{ external_account_id: externalId, account_id: foreign }] })).status, 404);

  // Valid mapping (and a blank external id in the list is skipped).
  const ok = await client.post(`/api/connections/${linkId}/map`, { mappings: [
    { external_account_id: '', account_id: acct },
    { external_account_id: externalId, account_id: acct },
  ] });
  assert.equal(ok.status, 200);
  const after = (await client.get('/api/connections')).body.find((l: any) => l.id === linkId);
  assert.equal(after.accounts.find((a: any) => a.external_account_id === externalId).account_id, acct);

  // Unmap (account_id null).
  assert.equal((await client.post(`/api/connections/${linkId}/map`, { mappings: [{ external_account_id: externalId, account_id: null }] })).status, 200);
});

// ── Create a local account pre-filled from an external account ────────────────
test('create-account: validation, creates + links, 409 if already linked', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId, externalId } = await seedLink(bookId, { balance: 250 });

  // Missing external_account_id → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/create-account`, {})).status, 400);
  // Unknown external account → 404.
  assert.equal((await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: 'nope' })).status, 404);

  // Create (an unknown type falls back to 'checking').
  const created = await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: externalId, type: 'weird', name: 'My Checking' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'My Checking');
  assert.equal(created.body.type, 'checking');

  // Now already linked → 409.
  assert.equal((await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: externalId })).status, 409);
});

test('create-account: a liability type sets is_liability', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId, externalId } = await seedLink(bookId, { balance: -100 });
  const created = await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: externalId, type: 'credit_card' });
  assert.equal(created.status, 201);
  assert.equal(created.body.is_liability, true);
});

// ── Apply settings (whole-account + single-field) ────────────────────────────
test('apply-settings: 400 when unlinked, single-field + whole-account apply, unknown field → 400', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Old Name', type: 'checking' })).body.id;
  const { linkId, externalId } = await seedLink(bookId, { accountId: acct, name: 'SF Bank Checking', balance: 100 });

  // Missing external id → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/apply-settings`, {})).status, 400);
  // Unknown field → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/apply-settings`, { external_account_id: externalId, field: 'nope' })).status, 400);

  // Single-field apply (name).
  const single = await client.post(`/api/connections/${linkId}/apply-settings`, { external_account_id: externalId, field: 'name' });
  assert.equal(single.status, 200);
  assert.equal(single.body.name, 'SF Bank Checking');

  // Whole-account apply (no field) also records the balance snapshot.
  const whole = await client.post(`/api/connections/${linkId}/apply-settings`, { external_account_id: externalId });
  assert.equal(whole.status, 200);

  // Apply on an external account that is NOT linked → 400.
  const unlinked = await seedLink(bookId, { externalId: 'ext-unlinked' });
  assert.equal((await client.post(`/api/connections/${unlinked.linkId}/apply-settings`, { external_account_id: 'ext-unlinked' })).status, 400);
});

// ── Dismiss a per-field suggestion ───────────────────────────────────────────
test('dismiss-suggestion: validation + persists the dismissed value', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  const { linkId, externalId } = await seedLink(bookId, { accountId: acct });

  assert.equal((await client.post(`/api/connections/${linkId}/dismiss-suggestion`, {})).status, 400);
  assert.equal((await client.post(`/api/connections/${linkId}/dismiss-suggestion`, { external_account_id: externalId, field: 'nope' })).status, 400);
  const ok = await client.post(`/api/connections/${linkId}/dismiss-suggestion`, { external_account_id: externalId, field: 'name', value: 'SF Name' });
  assert.equal(ok.status, 200);
  const nullVal = await client.post(`/api/connections/${linkId}/dismiss-suggestion`, { external_account_id: externalId, field: 'currency', value: null });
  assert.equal(nullVal.status, 200);
});

// ── Per-connection settings ──────────────────────────────────────────────────
test('settings: no-fields → 400, bad enum/date → 400, valid subset updates, 404 unknown link', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId } = await seedLink(bookId);

  // No settings provided → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/settings`, {})).status, 400);
  // Bad frequency enum → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/settings`, { auto_import_frequency: 'hourly' })).status, 400);
  // Bad boolean → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/settings`, { include_pending: 'maybe' })).status, 400);
  // Bad start-at date → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/settings`, { auto_import_start_at: 'not-a-date' })).status, 400);

  // Valid subset (booleans, frequency, and a start-at, plus clearing it).
  assert.equal((await client.post(`/api/connections/${linkId}/settings`, { include_pending: false, auto_import_enabled: true, auto_import_frequency: 'weekly', auto_import_start_at: '2026-09-01T08:00' })).status, 200);
  // Pending imports are off for now, so turning them on is refused.
  const pending = await client.post(`/api/connections/${linkId}/settings`, { include_pending: true });
  assert.equal(pending.status, 400);
  assert.match(pending.body.error, /once they post/);
  assert.equal((await client.post(`/api/connections/${linkId}/settings`, { auto_import_start_at: '' })).status, 200);

  // Unknown link → 404.
  assert.equal((await client.post('/api/connections/999999/settings', { include_pending: false })).status, 404);
});

// ── Per-account auto-import toggle ────────────────────────────────────────────
test('account-auto: validation + toggle, 404 unknown external account', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId, externalId } = await seedLink(bookId);

  assert.equal((await client.post(`/api/connections/${linkId}/account-auto`, {})).status, 400);
  // Missing auto_import boolean → 400.
  assert.equal((await client.post(`/api/connections/${linkId}/account-auto`, { external_account_id: externalId })).status, 400);
  // Valid toggle.
  assert.equal((await client.post(`/api/connections/${linkId}/account-auto`, { external_account_id: externalId, auto_import: true })).status, 200);
  // Unknown external account → 404.
  assert.equal((await client.post(`/api/connections/${linkId}/account-auto`, { external_account_id: 'nope', auto_import: true })).status, 404);
});

// ── Sync + import input validation (before any network) ───────────────────────
test('sync: 404 unknown link, 400 when nothing mapped', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId } = await seedLink(bookId); // account_id null → nothing mapped

  assert.equal((await client.post('/api/connections/999999/sync', {})).status, 404);
  assert.equal((await client.post(`/api/connections/${linkId}/sync`, {})).status, 400);
});

test('import: 400 when no accounts selected or none linked', async () => {
  const { client, bookId } = await registerUser(base);
  // No account_ids → 400.
  assert.equal((await client.post('/api/connections/import', {})).status, 400);
  assert.equal((await client.post('/api/connections/import', { account_ids: [] })).status, 400);
  // An account not linked to any connection → 400.
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  assert.equal((await client.post('/api/connections/import', { account_ids: [acct] })).status, 400);
  // Same guard applies to the streamed import (thrown before streaming begins).
  assert.equal((await client.post('/api/connections/import/stream', { account_ids: [] })).status, 400);
  void bookId;
});

// ── Refresh: 404 on unknown link (network error path is exercised via a real link) ──
test('refresh: 404 on unknown link', async () => {
  const { client } = await registerUser(base);
  assert.equal((await client.post('/api/connections/999999/refresh', {})).status, 404);
  assert.equal((await client.post('/api/connections/999999/refresh/stream', {})).status, 404);
});

// ── Delete a connection ──────────────────────────────────────────────────────
test('delete removes the connection (and is tenant-scoped)', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId } = await seedLink(bookId);
  // Another book cannot delete it (no error, but it stays).
  const other = await registerUser(base);
  assert.equal((await other.client.del(`/api/connections/${linkId}`)).status, 204);
  assert.ok((await client.get('/api/connections')).body.some((l: any) => l.id === linkId), 'still present after a foreign delete');

  // The owner can delete it.
  assert.equal((await client.del(`/api/connections/${linkId}`)).status, 204);
  assert.ok(!(await client.get('/api/connections')).body.some((l: any) => l.id === linkId));
});

// ── Exported helpers: upsert + mark-absent (no network) ──────────────────────
test('upsertAccountLinks discovers new external accounts; markAbsentLinks flags gone ones', async () => {
  const { bookId } = await registerUser(base);
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const link = (await db.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret('https://u:p@bridge.simplefin.org/simplefin')]
    )).rows[0];

    const accounts: any[] = [
      { id: 'x-1', name: 'Chk', org: { name: 'Bank' }, currency: 'USD', balance: '100.00', 'balance-date': 1700000000 },
      { id: 'x-2', name: 'Sav', org: { domain: 'bank.com' }, currency: 'USD', balance: '50.00', 'balance-date': 1700000000 },
    ];
    await upsertAccountLinks(db as any, bookId, link.id, accounts);
    let rows = (await db.query(`SELECT external_account_id, org_name FROM account_links WHERE link_id = $1 ORDER BY external_account_id`, [link.id])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1].org_name, 'bank.com'); // org.domain fallback

    // Re-upsert refreshes metadata (ON CONFLICT), doesn't duplicate.
    await upsertAccountLinks(db as any, bookId, link.id, accounts);
    rows = (await db.query(`SELECT count(*)::int AS n FROM account_links WHERE link_id = $1`, [link.id])).rows;
    assert.equal(rows[0].n, 2);

    // Only x-1 is present now → x-2 gets flagged missing.
    await markAbsentLinks(db as any, bookId, link.id, ['x-1']);
    const missing = (await db.query(`SELECT external_account_id FROM account_links WHERE link_id = $1 AND missing_since IS NOT NULL`, [link.id])).rows;
    assert.equal(missing.length, 1);
    assert.equal(missing[0].external_account_id, 'x-2');

    // An empty present set is a no-op (transient empty pull must not flag everything).
    await markAbsentLinks(db as any, bookId, link.id, []);
    const stillOne = (await db.query(`SELECT count(*)::int AS n FROM account_links WHERE link_id = $1 AND missing_since IS NOT NULL`, [link.id])).rows[0].n;
    assert.equal(stillOne, 1);
  } finally {
    await db.end();
  }
});

// ── applySimplefinSync: the DB-only side of a sync (no network) ──────────────
test('applySimplefinSync stages a payload, creates a batch, and settles link status', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body;
  const { linkId } = await seedLink(bookId, { accountId: acct.id });

  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const payload: any[] = [{
      org: { name: 'Test Bank' }, id: 'ext-1', name: 'SF Checking', currency: 'USD',
      balance: '321.00', 'balance-date': 1700000000,
      transactions: [
        { id: 'apply-tx-1', posted: 1700000000, amount: '-20.00', description: 'STORE' },
        { id: 'apply-tx-2', posted: 1700086400, amount: '150.00', description: 'DEPOSIT' },
      ],
    }];
    const mapByExt = new Map<string, number>([['ext-1', acct.id]]);
    const r = await applySimplefinSync(db as any, bookId, linkId, payload, mapByExt, null, ['a warning']);
    assert.equal(r.added, 2, 'two transactions staged');
    assert.ok(r.batch_id);

    // The link is settled to 'active' with the account_errors recorded.
    const link = (await db.query(`SELECT status, account_errors FROM institution_links WHERE id = $1`, [linkId])).rows[0];
    assert.equal(link.status, 'active');
    assert.deepEqual(link.account_errors, ['a warning']);

    // The batch's total_rows was updated to the payload total.
    const batch = (await db.query(`SELECT total_rows FROM import_batches WHERE id = $1`, [r.batch_id])).rows[0];
    assert.equal(batch.total_rows, 2);
  } finally {
    await db.end();
  }
});

// ── Network-error branches: refresh / sync / import against a dead https host ─
test('refresh + refresh/stream mark the link errored when the provider is unreachable', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId } = await seedLink(bookId, { accessUrl: DEAD_URL });

  // Non-streamed refresh: the fetch fails, the link is marked 'error', and the route rethrows.
  const r = await client.post(`/api/connections/${linkId}/refresh`, {});
  assert.ok(r.status >= 500, `refresh surfaces the fetch error (got ${r.status})`);

  // The streamed refresh always 200s (errors are sent as an in-band event).
  const s = await client.raw('POST', `/api/connections/${linkId}/refresh/stream`, {});
  assert.equal(s.status, 200);

  // The link's status is now 'error'.
  const conn = (await client.get('/api/connections')).body.find((l: any) => l.id === linkId);
  assert.equal(conn.status, 'error');
  assert.ok(conn.last_error);
});

test('sync marks the link errored when the provider is unreachable', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  const { linkId } = await seedLink(bookId, { accessUrl: DEAD_URL, accountId: acct });
  const r = await client.post(`/api/connections/${linkId}/sync`, {});
  assert.ok(r.status >= 500, `sync surfaces the fetch error (got ${r.status})`);
  const conn = (await client.get('/api/connections')).body.find((l: any) => l.id === linkId);
  assert.equal(conn.status, 'error');
});

test('import (JSON + stream) handles an unreachable connection cleanly', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  await seedLink(bookId, { accessUrl: DEAD_URL, accountId: acct });

  // JSON import: the per-connection fetch fails, but the route still returns a summary
  // (the connection is skipped, marked error) rather than throwing.
  const r = await client.post('/api/connections/import', { account_ids: [acct] });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 0);

  // Streamed import ends with a done/error event, status 200.
  const s = await client.raw('POST', '/api/connections/import/stream', { account_ids: [acct] });
  assert.equal(s.status, 200);
});

// ── Scheduled background sync (exported) against a dead host ──────────────────
test('syncAllSimplefinLinksSafe runs the schedule and records a per-link error', async () => {
  const { bookId } = await registerUser(base);
  const acct = (await registerUser(base)); void acct; // ensure >1 book to enumerate
  const db = testDbClient();
  await db.connect();
  let acctId: number;
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    acctId = (await db.query(`INSERT INTO accounts (book_id, name, type) VALUES ($1,'Chk','checking') RETURNING id`, [bookId])).rows[0].id;
  } finally {
    await db.end();
  }
  // An auto-import-enabled link that is due, with a mapped auto_import account.
  const { linkId } = await seedLink(bookId, { accessUrl: DEAD_URL, accountId: acctId, autoImport: true, autoImportEnabled: true });

  // Never throws; the unreachable host is caught and the link marked 'error'.
  await syncAllSimplefinLinksSafe();

  const db2 = testDbClient();
  await db2.connect();
  try {
    await db2.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const status = (await db2.query(`SELECT status FROM institution_links WHERE id = $1`, [linkId])).rows[0].status;
    assert.equal(status, 'error');
  } finally {
    await db2.end();
  }
});

// ── One supported currency (USD): foreign-currency accounts are refused, not summed ──
test('a foreign-currency SimpleFIN account can be listed but not created, applied, or synced', async () => {
  const { client, bookId } = await registerUser(base);
  const { linkId, externalId } = await seedLink(bookId, { externalId: 'ext-eur', name: 'Euro Account', currency: 'EUR' });
  const created = await client.post(`/api/connections/${linkId}/create-account`, { external_account_id: externalId });
  assert.equal(created.status, 400);
  assert.match(created.body.error, /in EUR.*US dollars \(USD\) only/);

  // A USD account already mapped can't take EUR via the currency suggestion.
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body;
  const usd = await seedLink(bookId, { externalId: 'ext-mixed', accountId: acct.id, currency: 'EUR' });
  assert.equal((await client.post(`/api/connections/${usd.linkId}/apply-settings`, { external_account_id: 'ext-mixed', field: 'currency' })).status, 400);

  // Syncing skips the EUR account (reported in account_errors) and imports the USD one.
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const payload: any[] = [
      { org: { name: 'Bank' }, id: 'ext-usd', name: 'Checking', currency: 'USD', balance: '10', 'balance-date': 1700000000,
        transactions: [{ id: 'usd-1', posted: 1700000000, amount: '-5.00', description: 'COFFEE' }] },
      { org: { name: 'Bank' }, id: 'ext-eur2', name: 'Euro', currency: 'EUR', balance: '99', 'balance-date': 1700000000,
        transactions: [{ id: 'eur-1', posted: 1700000000, amount: '-50.00', description: 'CAFE' }] },
    ];
    const eurAcct = (await client.post('/api/accounts', { name: 'Euro (manual)', type: 'checking' })).body;
    const mapByExt = new Map<string, number>([['ext-usd', acct.id], ['ext-eur2', eurAcct.id]]);
    const r = await applySimplefinSync(db as any, bookId, linkId, payload, mapByExt, null);
    assert.equal(r.added, 1, 'only the USD transaction is staged');
    const link = (await db.query(`SELECT account_errors FROM institution_links WHERE id = $1`, [linkId])).rows[0];
    assert.ok(link.account_errors.some((e: string) => /Euro is in EUR/.test(e)));
  } finally {
    await db.end();
  }
});

test('a synced balance is dated when the bank measured it, in the owner\'s timezone', async () => {
  const { client, bookId } = await registerUser(base);
  await client.put('/api/auth/profile', { timezone: 'America/Chicago' });
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body;
  const { linkId } = await seedLink(bookId, { externalId: 'tz-1', accountId: acct.id });
  // Measured 2026-09-08 03:00 UTC = 2026-09-07 22:00 in Chicago; synced weeks later.
  const measured = Date.UTC(2026, 8, 8, 3, 0, 0) / 1000;
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await applySimplefinSync(db as any, bookId, linkId,
      [{ org: { name: 'Bank' }, id: 'tz-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': measured, transactions: [] }] as any,
      new Map([['tz-1', acct.id]]), null);
    const snap = (await db.query(`SELECT to_char(as_of, 'YYYY-MM-DD') AS d, balance::float8 AS b FROM account_balances WHERE account_id = $1`, [acct.id])).rows;
    assert.deepEqual(snap, [{ d: '2026-09-07', b: 1000 }], 'the bank\'s day in Chicago, not the sync day or the UTC day');
  } finally {
    await db.end();
  }
  // Something that posted after the bank measured the balance still counts.
  await client.post('/api/transactions', { amount: 100, account_id: acct.id, direction: 'expense', txn_date: '2026-09-08', posted_date: '2026-09-08' });
  assert.equal(Number((await client.get(`/api/accounts/${acct.id}`)).body.posted_balance), 900);
});

// ── Pending imports are off: a link saved with include_pending still syncs posted only ─
test('sync asks SimpleFIN for posted transactions only, even if a link had include_pending on', async () => {
  const { client, bookId } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Chk', type: 'checking' })).body.id;
  const { linkId } = await seedLink(bookId, { accountId: acct });
  const db = testDbClient();
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await db.query(`UPDATE institution_links SET include_pending = true WHERE id = $1`, [linkId]);
  } finally {
    await db.end();
  }
  const urls: string[] = [];
  setExternalFetch(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ errors: [], accounts: [{
      org: { name: 'Test Bank' }, id: 'ext-1', name: 'SF Checking', currency: 'USD', balance: '100.00', 'balance-date': 1700000000,
      transactions: [
        { id: 'posted-1', posted: 1700000000, amount: '-5.00', description: 'COFFEE' },
        { id: 'pending-1', posted: 0, transacted_at: 1700000000, amount: '-7.00', description: 'LUNCH', pending: true },
      ],
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const r = await client.post(`/api/connections/${linkId}/sync`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    setExternalFetch(null);
  }
  assert.ok(urls.length > 0);
  for (const u of urls) assert.equal(new URL(u).searchParams.get('pending'), '0');
  const conn = (await client.get('/api/connections')).body.find((l: any) => l.id === linkId);
  assert.equal(conn.include_pending, false, 'reported as off');
  const db2 = testDbClient();
  await db2.connect();
  try {
    await db2.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    const ext = (await db2.query(`SELECT external_id FROM staged_transactions WHERE book_id = $1 ORDER BY external_id`, [bookId])).rows.map((x) => x.external_id);
    assert.deepEqual(ext, ['posted-1'], 'a pending row sent anyway is not staged');
  } finally {
    await db2.end();
  }
});
