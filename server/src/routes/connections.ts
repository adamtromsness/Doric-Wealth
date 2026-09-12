// Linked-account (automatic import) connections. Phase 1: claim a SimpleFIN setup
// token, list connections + their external accounts, map external accounts to
// internal accounts, and remove a connection. Syncing transactions is Phase 2.
//
// All routes are owner/admin-only (requireManager): a bank feed is an account-wide
// capability, like backup/restore — not something an individual member sets up.
import { Router } from 'express';
import { query, one, withTransaction, pool } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh, requireManager } from '../tenant.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { claimAccessUrl, fetchAccounts, type SfAccount, type SfHolding } from '../simplefin.js';
import { integerId, optionalIntegerId, booleanValue, optionalDateOnly, enumValue, round2 } from '../validation.js';
import { dateInTz } from '../dates.js';
import { cleanMerchant, setImportStatus, autoLinkTransferRules } from './imports.js';

export const connections = Router();

// Upsert account_links for every external account the provider returns, so banks
// added to the connection AFTER it was claimed get discovered (they appear unmapped
// until the user maps them). ON CONFLICT only refreshes metadata — it never clears an
// existing account_id mapping.
export async function upsertAccountLinks(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  linkId: number,
  accounts: SfAccount[],
): Promise<void> {
  for (const a of accounts) {
    await client.query(
      `INSERT INTO account_links (book_id, link_id, external_account_id, name, org_name, currency, last_balance, last_balance_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))
       ON CONFLICT (link_id, external_account_id) DO UPDATE SET
         name = EXCLUDED.name, org_name = EXCLUDED.org_name, currency = EXCLUDED.currency,
         last_balance = EXCLUDED.last_balance, last_balance_date = EXCLUDED.last_balance_date,
         missing_since = NULL`,
      [bookId, linkId, a.id, a.name ?? null, a.org?.name ?? a.org?.domain ?? null, a.currency ?? null,
       a.balance ?? null, a['balance-date'] ?? null]
    );
  }
}

// Flag external accounts that previously appeared but are absent from this response, so
// the UI can prompt a re-auth at the bridge. Their stored data (mapping, last balance) is
// kept. Guarded on a non-empty present set so a transient empty pull doesn't flag all.
export async function markAbsentLinks(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  linkId: number,
  presentExternalIds: string[],
): Promise<void> {
  if (presentExternalIds.length === 0) return;
  await client.query(
    `UPDATE account_links SET missing_since = now()
      WHERE link_id = $1 AND book_id = $2 AND missing_since IS NULL
        AND NOT (external_account_id = ANY($3))`,
    [linkId, bookId, presentExternalIds]
  );
}

// Replace an account's stored holdings with the provider's latest set (current-snapshot
// model). Only runs when positions were actually returned — an empty/absent holdings
// list means "not reported", so we never wipe known holdings on a transient empty pull.
async function recordHoldings(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  accountId: number,
  holdings: SfHolding[] | undefined,
  asOfEpoch: number,
): Promise<void> {
  if (!Array.isArray(holdings) || holdings.length === 0) return;
  const asOf = new Date((asOfEpoch || Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10);
  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  await client.query(`DELETE FROM account_holdings WHERE account_id = $1 AND book_id = $2`, [accountId, bookId]);
  for (const h of holdings) {
    await client.query(
      `INSERT INTO account_holdings (book_id, account_id, external_id, symbol, description, shares, market_value, cost_basis, currency, as_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [bookId, accountId, h.id ?? null, h.symbol ?? null, h.description ?? null,
       num(h.shares), num(h.market_value), num(h.cost_basis), h.currency ?? null, asOf]
    );
  }
}

// Record a synced balance as a dated snapshot. Upserts the account_balances anchor
// and refreshes the append-only account_balance_events ledger (voiding any prior
// synced snapshot for the same date so re-syncs stay idempotent). SimpleFIN reports
// a liability (credit card / loan) balance as negative when money is owed; the app
// stores a liability anchor as the positive amount owed, so we negate for liabilities.
async function recordSyncedBalance(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  accountId: number,
  balance: number,
  balanceDateEpoch: number,
): Promise<void> {
  const acct = (await client.query(`SELECT is_liability FROM accounts WHERE id = $1 AND book_id = $2`, [accountId, bookId])).rows[0];
  if (!acct) return;
  const snapshotBalance = round2(acct.is_liability ? -balance : balance); // owed amount is stored positive
  const asOf = new Date(balanceDateEpoch * 1000).toISOString().slice(0, 10);
  await client.query(
    `INSERT INTO account_balances (account_id, balance, as_of, book_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, as_of) DO UPDATE SET balance = EXCLUDED.balance`,
    [accountId, snapshotBalance, asOf, bookId]
  );
  await client.query(
    `UPDATE account_balance_events SET voided_at = now()
      WHERE account_id = $1 AND book_id = $2 AND as_of = $3
        AND source = 'simplefin' AND event_type = 'snapshot' AND voided_at IS NULL`,
    [accountId, bookId, asOf]
  );
  await client.query(
    `INSERT INTO account_balance_events (book_id, account_id, as_of, balance, event_type, source)
     VALUES ($1, $2, $3, $4, 'snapshot', 'simplefin')`,
    [bookId, accountId, asOf, snapshotBalance]
  );
}

// Stage a SimpleFIN payload into staged_transactions, deduped by the provider's
// stable transaction id (already-committed OR already-staged ids are skipped, so
// re-syncing the same data is idempotent). Amounts are sign-mapped (negative = money
// out → expense). Kept free of network I/O — the route fetches, this stages — so it
// can be tested deterministically by replaying the same payload twice.
export async function stageSimplefinTxns(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  linkId: number,
  batchId: number,
  accounts: SfAccount[],
  mapByExt: Map<string, number>,
): Promise<{ added: number; skipped: number; total: number; touched: number[]; balances: { name: string; balance: number; currency: string }[] }> {
  let added = 0, skipped = 0, total = 0;
  const nowS = Math.floor(Date.now() / 1000);
  const touched = new Set<number>();
  const balances: { name: string; balance: number; currency: string }[] = [];

  // The provider sends epoch timestamps; convert them to calendar dates in the book
  // owner's timezone (not the server's UTC day), so a transaction near midnight isn't
  // dated a day off for users west of UTC. Fetched once (null → UTC).
  const ownerTz: string | null = (await client.query(
    `SELECT u.timezone FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.book_id = $1 ORDER BY (m.role = 'owner') DESC, m.created_at LIMIT 1`,
    [bookId]
  )).rows[0]?.timezone ?? null;

  // Prefetch once to avoid an N+1 across (potentially thousands of) payload rows:
  //   (a) every provider id already known for this book (committed / staged / consumed)
  //       so the exact-dedup check is an in-memory lookup, not a query per row;
  //   (b) the most-recent category per merchant for category inheritance.
  // Both are bounded by the book's own history. The legacy (no-external-id) fallback
  // stays a per-row query — it's index-backed and only runs for genuinely-new rows.
  const knownExt = new Set<string>(
    (await client.query(
      `SELECT external_id FROM transactions          WHERE book_id = $1 AND source = 'simplefin' AND external_id IS NOT NULL
       UNION SELECT external_id FROM staged_transactions   WHERE book_id = $1 AND source = 'simplefin' AND external_id IS NOT NULL
       UNION SELECT external_id FROM consumed_external_ids WHERE book_id = $1 AND source = 'simplefin'`,
      [bookId]
    )).rows.map((r: any) => String(r.external_id))
  );
  const catByMerchant = new Map<string, number>(
    (await client.query(
      `SELECT DISTINCT ON (lower(merchant)) lower(merchant) AS m, category_id
         FROM transactions
        WHERE book_id = $1 AND category_id IS NOT NULL AND merchant IS NOT NULL AND btrim(merchant) <> ''
        ORDER BY lower(merchant), txn_date DESC, id DESC`,
      [bookId]
    )).rows.map((r: any) => [r.m as string, r.category_id as number] as const)
  );

  for (const a of accounts) {
    const accountId = mapByExt.get(a.id);
    if (!accountId) continue; // external account not mapped → ignore
    touched.add(accountId);
    await client.query(
      `UPDATE account_links SET last_balance = $1, last_balance_date = to_timestamp($2)
        WHERE link_id = $3 AND external_account_id = $4 AND book_id = $5`,
      [a.balance ?? null, a['balance-date'] ?? null, linkId, a.id, bookId]
    );

    // Record the bank's authoritative balance as a snapshot dated to the pull (nowS),
    // not the bank's balance-date — so a sync immediately brings the account's current
    // balance up to the latest reported figure even when the bank's balance-date lags.
    // (recordSyncedBalance handles the asset vs. liability sign convention.) The guard
    // still requires a real balance reading (balance + balance-date present).
    if (a.balance != null && a['balance-date'] != null && Number.isFinite(Number(a.balance))) {
      await recordSyncedBalance(client, bookId, accountId, Number(a.balance), nowS);
      balances.push({ name: a.name, balance: Number(a.balance), currency: a.currency || 'USD' });
    }
    // Replace this account's holdings/composition when the provider reports positions.
    await recordHoldings(client, bookId, accountId, a.holdings, a['balance-date']);

    for (const t of a.transactions ?? []) {
      total++;
      const amt = Number(t.amount);
      if (!Number.isFinite(amt) || amt === 0) { skipped++; continue; }
      const direction = amt < 0 ? 'expense' : 'income';        // negative = money out
      const amount = round2(Math.abs(amt)); // snap provider float to cents so the dedup match below is exact
      // SimpleFIN sends posted=0 for still-pending transactions, so `||` (not `??`)
      // is required — fall back to the transaction time, then now, never epoch 0.
      const ts = t.posted || t.transacted_at || nowS;
      const txnDate = dateInTz(ts * 1000, ownerTz);
      const rawMerch = (t.payee || t.description || '').trim() || null;
      const merchant = rawMerch ? cleanMerchant(rawMerch) : null;

      // Dedup: (1) exact provider id — committed OR already in review (in-memory set).
      const exact = knownExt.has(String(t.id));
      // (2) fallback for rows imported before provenance was tracked: a committed
      // transaction with NO external_id that matches account/amount/direction/merchant
      // within ±4 days. Scoped to external_id IS NULL so it never skips a genuine new
      // charge once everything carries a provider id.
      let isDup = !!exact;
      if (!isDup) {
        const legacy = (await client.query(
          `SELECT 1 FROM transactions
            WHERE book_id = $1 AND account_id = $2 AND external_id IS NULL
              AND amount = $3 AND direction = $4
              AND txn_date BETWEEN $5::date - 4 AND $5::date + 4
              AND lower(coalesce(merchant, '')) = lower(coalesce($6, ''))
            LIMIT 1`,
          [bookId, accountId, amount, direction, txnDate, merchant]
        )).rows[0];
        isDup = !!legacy;
      }
      if (isDup) { skipped++; continue; }

      // Suggest a category from how this merchant was categorized before (prefetched).
      const categoryId: number | null = merchant ? (catByMerchant.get(merchant.toLowerCase()) ?? null) : null;

      // ON CONFLICT is the race safety net behind the dedup check above: if a
      // concurrent sync already staged this provider id, skip it instead of creating a
      // duplicate that would later break the bulk confirm (see migration 125).
      const ins = await client.query(
        `INSERT INTO staged_transactions
           (book_id, batch_id, source, external_id, account_id, category_id, txn_date, amount, direction,
            merchant, raw_merchant, description, raw, decision)
         VALUES ($1,$2,'simplefin',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'import')
         ON CONFLICT (book_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
        [bookId, batchId, t.id, accountId, categoryId, txnDate, amount, direction,
         merchant, rawMerch, t.memo ?? t.description ?? null, JSON.stringify(t)]
      );
      if (ins.rowCount) added++; else skipped++;
      knownExt.add(String(t.id)); // now known — a repeat later in this same payload is skipped
    }
  }
  return { added, skipped, total, touched: [...touched], balances };
}

// DB-only side of a sync: create the batch, stage the payload, settle status. The
// caller owns the transaction AND the network fetch (kept out of here so a fetch
// never holds a DB connection). Shared by the on-demand route and the scheduled poll.
export async function applySimplefinSync(
  client: { query: (text: string, params: any[]) => Promise<any> },
  bookId: number,
  linkId: number,
  accounts: SfAccount[],
  mapByExt: Map<string, number>,
  userId: number | null,
  errors: string[] = [],
): Promise<{ added: number; skipped: number; total: number; batch_id: number }> {
  // Discover any newly-added external accounts so they show up (unmapped) for the user;
  // flag any that have stopped appearing.
  await upsertAccountLinks(client, bookId, linkId, accounts);
  await markAbsentLinks(client, bookId, linkId, accounts.map((a) => a.id));
  const batch = (await client.query(
    `INSERT INTO import_batches (book_id, account_id, filename, source, total_rows, created_by)
     VALUES ($1, NULL, 'SimpleFIN sync', 'simplefin', 0, $2) RETURNING id`,
    [bookId, userId]
  )).rows[0];
  const r = await stageSimplefinTxns(client, bookId, linkId, batch.id, accounts, mapByExt);
  await client.query(`UPDATE import_batches SET total_rows = $2 WHERE id = $1`, [batch.id, r.total]);
  for (const aid of r.touched) await setImportStatus(client, bookId, aid, 'staged');
  await client.query(
    `UPDATE institution_links SET last_synced_at = now(), status = 'active', last_error = NULL, account_errors = $3
      WHERE id = $1 AND book_id = $2`,
    [linkId, bookId, errors]
  );
  return { added: r.added, skipped: r.skipped, total: r.total, batch_id: batch.id };
}

// ── Scheduled background sync ──────────────────────────────────────────────────
// Runs outside any HTTP request, so it must establish the RLS tenant context itself.
// `books` is not under RLS (an identity table), so we enumerate it directly,
// then set app.book_id per book to read/write that tenant's rows.

async function withBookTx<T>(bookId: number, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('app.book_id', $1, false)`, [String(bookId)]);
    await client.query('BEGIN');
    try { const r = await fn(client); await client.query('COMMIT'); return r; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
  } finally {
    await client.query('RESET ALL').catch(() => {});
    client.release();
  }
}

async function markLinkError(bookId: number, linkId: number, e: any): Promise<void> {
  try {
    await withBookTx(bookId, (client) =>
      client.query(`UPDATE institution_links SET status = 'error', last_error = $2 WHERE id = $1 AND book_id = $3`,
        [linkId, String(e?.message ?? 'Sync failed.').slice(0, 300), bookId]));
  } catch (writeErr) {
    // Best-effort, but don't fail silently: if we can't even record the error, a
    // stuck link would otherwise look healthy. Log both the original and the write failure.
    console.error(`markLinkError: failed to record sync error for link ${linkId} (book ${bookId}):`, writeErr, '— original error:', e?.message ?? e);
  }
}

async function syncBookLinks(bookId: number): Promise<void> {
  // Read this book's auto-import-enabled links with their schedule anchor; "due"
  // is computed in JS against the start time + frequency so the schedule fires aligned
  // to the user's chosen time-of-day. Network fetch happens after (no connection held).
  let links: any[] = [];
  const reader = await pool.connect();
  try {
    await reader.query(`SELECT set_config('app.book_id', $1, true)`, [String(bookId)]);
    links = (await reader.query(
      `SELECT id, access_url_enc, include_pending, auto_import_frequency,
              EXTRACT(EPOCH FROM last_synced_at)::bigint AS last_synced_epoch,
              EXTRACT(EPOCH FROM COALESCE(auto_import_start_at, created_at))::bigint AS start_epoch
         FROM institution_links
        WHERE book_id = $1 AND status <> 'revoked' AND auto_import_enabled = true`,
      [bookId]
    )).rows;
  } finally {
    await reader.query('RESET ALL').catch(() => {});
    reader.release();
  }

  const nowS = Math.floor(Date.now() / 1000);
  // A link is due if we're past its start and haven't synced since the most recent
  // scheduled fire (start + k*period), aligning runs to the chosen time-of-day.
  const due = links.filter((l) => {
    const start = Number(l.start_epoch);
    if (nowS < start) return false;
    const period = l.auto_import_frequency === 'weekly' ? 7 * 86400 : 86400;
    const lastFire = start + Math.floor((nowS - start) / period) * period;
    const lastSynced = l.last_synced_epoch != null ? Number(l.last_synced_epoch) : null;
    return lastSynced == null || lastSynced < lastFire;
  });

  for (const link of due) {
    const since = link.last_synced_epoch ? Number(link.last_synced_epoch) - 4 * 86400 : nowS - 90 * 86400;
    let pulled;
    try {
      pulled = await fetchAccounts(decryptSecret(link.access_url_enc), { startDate: since, pending: link.include_pending });
    } catch (e) {
      await markLinkError(bookId, link.id, e);
      continue;
    }
    try {
      await withBookTx(bookId, async (client) => {
        // Only the accounts the user opted into the schedule (auto_import) are synced.
        const mapped = (await client.query(
          `SELECT external_account_id, account_id FROM account_links
            WHERE link_id = $1 AND book_id = $2 AND account_id IS NOT NULL AND auto_import = true`,
          [link.id, bookId]
        )).rows;
        if (mapped.length === 0) return;
        const mapByExt = new Map<string, number>(mapped.map((m: any) => [m.external_account_id, m.account_id]));
        await applySimplefinSync(client, bookId, link.id, pulled.accounts, mapByExt, null, pulled.errors);
      });
    } catch (e) {
      await markLinkError(bookId, link.id, e);
    }
  }
  // Apply remembered transfer rules so scheduled imports auto-link known pairs (e.g. a
  // card autopay) without waiting for the user to open the review queue.
  if (due.length) {
    try { await withBookTx(bookId, (client) => autoLinkTransferRules(client, bookId)); }
    catch (e) { console.error(`auto-link transfers failed for book ${bookId}:`, e); }
  }
}

// Sync every book's stale linked connections. Called on a daily interval (and
// shortly after boot). Failures are isolated per link and never throw.
export async function syncAllSimplefinLinksSafe(): Promise<void> {
  try {
    const hs = await pool.query(`SELECT id FROM books ORDER BY id`);
    for (const h of hs.rows as any[]) await syncBookLinks(h.id);
  } catch (e) {
    console.error('scheduled SimpleFIN sync failed:', e);
  }
}

// Claim a SimpleFIN setup token → store the (encrypted) access URL and surface the
// connection's external accounts for mapping.
connections.post('/simplefin/claim', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const setupToken = String(req.body?.setupToken ?? '').trim();
  if (!setupToken) throw new HttpError(400, 'Paste your SimpleFIN setup token to connect.');

  const accessUrl = await claimAccessUrl(setupToken);
  // Pull accounts now: validates the access URL works and gives the user something
  // to map immediately.
  const { accounts } = await fetchAccounts(accessUrl);

  const linkId = await withTransaction(async (client) => {
    const link = (await client.query(
      `INSERT INTO institution_links (book_id, provider, access_url_enc, status)
       VALUES ($1, 'simplefin', $2, 'active') RETURNING id`,
      [bookId, encryptSecret(accessUrl)]
    )).rows[0];
    await upsertAccountLinks(client, bookId, link.id, accounts);
    return link.id as number;
  });

  res.status(201).json({
    id: linkId,
    accounts: accounts.map((a) => ({
      external_account_id: a.id, name: a.name,
      org: a.org?.name ?? a.org?.domain ?? null, balance: a.balance, currency: a.currency,
    })),
  });
}));

// List connections with their external accounts (and current internal mapping).
connections.get('/', ah(async (req, res) => {
  const bookId = hh(req);
  const links = await query(
    `SELECT id, provider, status, last_error, account_errors, include_pending, auto_import_enabled, auto_import_frequency,
            to_char(auto_import_start_at, 'YYYY-MM-DD"T"HH24:MI') AS auto_import_start_at,
            to_char(last_synced_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_synced_at,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at
       FROM institution_links WHERE book_id = $1 ORDER BY id`,
    [bookId]
  );
  const accts = await query(
    `SELECT al.id, al.link_id, al.external_account_id, al.name AS sf_name, al.org_name, al.currency,
            al.last_balance, al.account_id, al.auto_import, a.name AS account_name,
            to_char(al.missing_since, 'YYYY-MM-DD') AS missing_since, al.dismissed_fields
       FROM account_links al
       LEFT JOIN accounts a ON a.id = al.account_id
      WHERE al.book_id = $1 ORDER BY al.id`,
    [bookId]
  );
  res.json(links.map((l: any) => ({ ...l, accounts: accts.filter((x: any) => x.link_id === l.id) })));
}));

// Map (or unmap) external accounts to internal accounts.
connections.post('/:id/map', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const link = await one(`SELECT id FROM institution_links WHERE id = $1 AND book_id = $2`, [linkId, bookId]);
  if (!link) throw new HttpError(404, 'Connection not found.');

  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
  await withTransaction(async (client) => {
    for (const m of mappings) {
      const externalId = String(m?.external_account_id ?? '').trim();
      if (!externalId) continue;
      const accountId = optionalIntegerId(m?.account_id, 'account_id');
      if (accountId != null) {
        const owned = (await client.query(`SELECT 1 FROM accounts WHERE id = $1 AND book_id = $2`, [accountId, bookId])).rows[0];
        if (!owned) throw new HttpError(404, 'Account not found in this book.');
      }
      await client.query(
        `UPDATE account_links SET account_id = $1
          WHERE link_id = $2 AND external_account_id = $3 AND book_id = $4`,
        [accountId, linkId, externalId, bookId]
      );
    }
  });
  res.json({ ok: true });
}));

// SimpleFIN reports name/balance/currency/institution but no account type, so callers
// pick the type when creating. is_liability is derived from the chosen type.
const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'asset', 'other'];
const LIABILITY_TYPES = new Set(['credit_card', 'loan']);

// Load one external account's stored SimpleFIN snapshot for this connection.
async function loadLink(client: any, bookId: number, linkId: number, externalId: string) {
  return (await client.query(
    `SELECT id, account_id, name, org_name, currency, last_balance::float8 AS last_balance,
            EXTRACT(EPOCH FROM last_balance_date)::bigint AS last_balance_epoch
       FROM account_links WHERE link_id = $1 AND external_account_id = $2 AND book_id = $3`,
    [linkId, externalId, bookId]
  )).rows[0];
}

// Create a local account pre-filled from a SimpleFIN external account, link them, and
// record the reported balance as a snapshot.
connections.post('/:id/create-account', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const externalId = String(req.body?.external_account_id ?? '').trim();
  if (!externalId) throw new HttpError(400, 'external_account_id is required.');
  const type = ACCOUNT_TYPES.includes(req.body?.type) ? req.body.type : 'checking';

  const created = await withTransaction(async (client) => {
    const link = await loadLink(client, bookId, linkId, externalId);
    if (!link) throw new HttpError(404, 'External account not found.');
    if (link.account_id) throw new HttpError(409, 'This external account is already linked to an account.');
    const name = (String(req.body?.name ?? '').trim()) || link.name || link.org_name || externalId;
    const acct = (await client.query(
      `INSERT INTO accounts (book_id, name, type, institution, currency, is_liability)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [bookId, name, type, link.org_name ?? null, link.currency ?? 'USD', LIABILITY_TYPES.has(type)]
    )).rows[0];
    await client.query(
      `UPDATE account_links SET account_id = $1 WHERE link_id = $2 AND external_account_id = $3 AND book_id = $4`,
      [acct.id, linkId, externalId, bookId]
    );
    if (link.last_balance != null) {
      await recordSyncedBalance(client, bookId, acct.id, Number(link.last_balance), Number(link.last_balance_epoch) || Math.floor(Date.now() / 1000));
    }
    return acct;
  });
  res.status(201).json(created);
}));

// Push the SimpleFIN-reported name/institution/currency onto the already-mapped account,
// and record its current balance.
connections.post('/:id/apply-settings', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const externalId = String(req.body?.external_account_id ?? '').trim();
  if (!externalId) throw new HttpError(400, 'external_account_id is required.');

  // Optional single-field apply (from the per-field suggestion rows). Maps the field name
  // to its column + the SimpleFIN-reported value.
  const FIELD_COL: Record<string, string> = { name: 'name', institution: 'institution', currency: 'currency' };
  const field = typeof req.body?.field === 'string' ? req.body.field : null;
  if (field && !FIELD_COL[field]) throw new HttpError(400, 'Unknown field.');

  const updated = await withTransaction(async (client) => {
    const link = await loadLink(client, bookId, linkId, externalId);
    if (!link) throw new HttpError(404, 'External account not found.');
    if (!link.account_id) throw new HttpError(400, 'This external account is not linked to an account yet.');

    if (field) {
      const value = field === 'name' ? link.name : field === 'institution' ? link.org_name : link.currency;
      const acct = (await client.query(
        `UPDATE accounts SET ${FIELD_COL[field]} = $3 WHERE id = $1 AND book_id = $2 RETURNING *`,
        [link.account_id, bookId, value ?? null]
      )).rows[0];
      if (!acct) throw new HttpError(404, 'Account not found.');
      return acct;
    }

    // No field → apply all settings + record the balance (legacy whole-account update).
    // Only overwrite name when SimpleFIN actually reported one (older links may lack it).
    const sets = ['institution = $2', 'currency = COALESCE($3, currency)'];
    const vals: any[] = [link.account_id, link.org_name ?? null, link.currency ?? null];
    if (link.name) { vals.push(link.name); sets.push(`name = $${vals.length}`); }
    vals.push(bookId);
    const acct = (await client.query(
      `UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 AND book_id = $${vals.length} RETURNING *`,
      vals
    )).rows[0];
    if (!acct) throw new HttpError(404, 'Account not found.');
    if (link.last_balance != null) {
      await recordSyncedBalance(client, bookId, acct.id, Number(link.last_balance), Number(link.last_balance_epoch) || Math.floor(Date.now() / 1000));
    }
    return acct;
  });
  res.json(updated);
}));

// Dismiss one field's "update from SimpleFIN" suggestion for a mapped account by
// remembering the proposed value; that field's suggestion reappears only if SimpleFIN
// later reports a different value.
const DISMISSIBLE_FIELDS = new Set(['name', 'institution', 'currency']);
connections.post('/:id/dismiss-suggestion', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const externalId = String(req.body?.external_account_id ?? '').trim();
  if (!externalId) throw new HttpError(400, 'external_account_id is required.');
  const field = String(req.body?.field ?? '');
  if (!DISMISSIBLE_FIELDS.has(field)) throw new HttpError(400, 'Unknown field.');
  const value = req.body?.value == null ? null : String(req.body.value).slice(0, 600);
  await query(
    `UPDATE account_links
        SET dismissed_fields = jsonb_set(COALESCE(dismissed_fields, '{}'::jsonb), ARRAY[$4], $5::jsonb)
      WHERE link_id = $1 AND external_account_id = $2 AND book_id = $3`,
    [linkId, externalId, bookId, field, JSON.stringify(value)]
  );
  res.json({ ok: true });
}));

// Re-discover the connection's external accounts (e.g. after adding banks in SimpleFIN)
// without syncing transactions. Newly-found accounts appear unmapped, ready to map.
connections.post('/:id/refresh', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const link = await one<any>(`SELECT access_url_enc FROM institution_links WHERE id = $1 AND book_id = $2`, [linkId, bookId]);
  if (!link) throw new HttpError(404, 'Connection not found.');

  const before = (await one<any>(`SELECT count(*)::int AS n FROM account_links WHERE link_id = $1 AND book_id = $2`, [linkId, bookId]))?.n ?? 0;
  let pulled;
  try {
    // Recent window — we only need account metadata here, not their transactions.
    pulled = await fetchAccounts(decryptSecret(link.access_url_enc), { startDate: Math.floor(Date.now() / 1000) });
  } catch (e: any) {
    await query(`UPDATE institution_links SET status = 'error', last_error = $2 WHERE id = $1 AND book_id = $3`,
      [linkId, String(e?.message ?? 'Refresh failed.').slice(0, 300), bookId]);
    throw e;
  }
  await withTransaction(async (client) => {
    await upsertAccountLinks(client, bookId, linkId, pulled.accounts);
    await markAbsentLinks(client, bookId, linkId, pulled.accounts.map((a) => a.id));
    await client.query(`UPDATE institution_links SET status = 'active', last_error = NULL, account_errors = $3 WHERE id = $1 AND book_id = $2`, [linkId, bookId, pulled.errors ?? []]);
  });
  const after = (await one<any>(`SELECT count(*)::int AS n FROM account_links WHERE link_id = $1 AND book_id = $2`, [linkId, bookId]))?.n ?? 0;
  res.json({ total: pulled.accounts.length, added: Math.max(0, after - before) });
}));

// Same refresh, streamed as newline-delimited JSON so the UI can show a progress bar.
connections.post('/:id/refresh/stream', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const link = await one<any>(`SELECT access_url_enc FROM institution_links WHERE id = $1 AND book_id = $2`, [linkId, bookId]);
  if (!link) throw new HttpError(404, 'Connection not found.');

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (ev: any) => { res.write(JSON.stringify(ev) + '\n'); };

  send({ type: 'start' });
  try {
    const before = (await one<any>(`SELECT count(*)::int AS n FROM account_links WHERE link_id = $1 AND book_id = $2`, [linkId, bookId]))?.n ?? 0;
    send({ type: 'status', message: 'Contacting SimpleFIN…' });
    const pulled = await fetchAccounts(decryptSecret(link.access_url_enc), { startDate: Math.floor(Date.now() / 1000) });
    const total = pulled.accounts.length;
    send({ type: 'status', message: `Found ${total} account${total === 1 ? '' : 's'}.`, total });
    await withTransaction(async (client) => {
      let i = 0;
      for (const a of pulled.accounts) {
        await upsertAccountLinks(client, bookId, linkId, [a]);
        i++;
        send({ type: 'progress', done: i, total, message: `Updated ${a.org?.name ? a.org.name + ' · ' : ''}${a.name}` });
      }
      await markAbsentLinks(client, bookId, linkId, pulled.accounts.map((a) => a.id));
      await client.query(`UPDATE institution_links SET status = 'active', last_error = NULL, account_errors = $3 WHERE id = $1 AND book_id = $2`, [linkId, bookId, pulled.errors ?? []]);
    });
    const after = (await one<any>(`SELECT count(*)::int AS n FROM account_links WHERE link_id = $1 AND book_id = $2`, [linkId, bookId]))?.n ?? 0;
    send({ type: 'done', total, added: Math.max(0, after - before), errors: pulled.errors ?? [] });
  } catch (e: any) {
    await query(`UPDATE institution_links SET status = 'error', last_error = $2 WHERE id = $1 AND book_id = $3`,
      [linkId, String(e?.message ?? 'Refresh failed.').slice(0, 300), bookId]).catch(() => {});
    send({ type: 'error', message: String(e?.message ?? 'Refresh failed.') });
  }
  res.end();
}));

// Pull new transactions for a connection into the review queue. Transactions are
// deduped by their stable SimpleFIN id (so re-syncing is idempotent), sign-mapped to
// a direction, and staged for review — they do NOT post to the ledger until approved.
// The network fetch runs OUTSIDE the DB transaction so it never holds a connection
// open across the HTTP call; all writes happen in one transaction afterward.
connections.post('/:id/sync', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');

  const link = await one<any>(
    `SELECT id, access_url_enc, include_pending, EXTRACT(EPOCH FROM last_synced_at)::bigint AS last_synced_epoch
       FROM institution_links WHERE id = $1 AND book_id = $2`,
    [linkId, bookId]
  );
  if (!link) throw new HttpError(404, 'Connection not found.');

  const mapped = await query<any>(
    `SELECT external_account_id, account_id FROM account_links
      WHERE link_id = $1 AND book_id = $2 AND account_id IS NOT NULL`,
    [linkId, bookId]
  );
  if (mapped.length === 0) throw new HttpError(400, 'Map at least one bank account to one of your accounts before syncing.');
  const mapByExt = new Map<string, number>(mapped.map((m: any) => [m.external_account_id, m.account_id]));

  // An explicit start_date backfills from that date (a one-off "import from…");
  // otherwise the first sync pulls ~90 days and later syncs pull since the last sync
  // with a 4-day overlap for late-posting items. Dedup by id makes any overlap safe.
  const startDate = optionalDateOnly(req.body?.start_date, 'start_date');
  const nowS = Math.floor(Date.now() / 1000);
  const since = startDate
    ? Math.floor(Date.parse(startDate + 'T00:00:00Z') / 1000)
    : link.last_synced_epoch ? Number(link.last_synced_epoch) - 4 * 86400 : nowS - 90 * 86400;

  let pulled;
  try {
    pulled = await fetchAccounts(decryptSecret(link.access_url_enc), { startDate: since, pending: link.include_pending });
  } catch (e: any) {
    await query(`UPDATE institution_links SET status = 'error', last_error = $2 WHERE id = $1 AND book_id = $3`,
      [linkId, String(e?.message ?? 'Sync failed.').slice(0, 300), bookId]);
    throw e;
  }

  const result = await withTransaction((client) =>
    applySimplefinSync(client, bookId, linkId, pulled.accounts, mapByExt, req.user?.id ?? null, pulled.errors));

  res.json(result);
}));

// Update per-connection import settings (include-pending + scheduled auto-import).
// Accepts any subset of the fields; only the provided ones are changed.
connections.post('/:id/settings', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const sets: string[] = []; const vals: any[] = [];
  if ('include_pending' in req.body) { vals.push(booleanValue(req.body.include_pending, 'include_pending')); sets.push(`include_pending = $${vals.length}`); }
  if ('auto_import_enabled' in req.body) { vals.push(booleanValue(req.body.auto_import_enabled, 'auto_import_enabled')); sets.push(`auto_import_enabled = $${vals.length}`); }
  if ('auto_import_frequency' in req.body) { vals.push(enumValue(req.body.auto_import_frequency, 'auto_import_frequency', ['daily', 'weekly'])); sets.push(`auto_import_frequency = $${vals.length}`); }
  if ('auto_import_start_at' in req.body) {
    const raw = req.body.auto_import_start_at;
    if (raw == null || raw === '') { vals.push(null); }
    else { if (Number.isNaN(Date.parse(String(raw)))) throw new HttpError(400, 'auto_import_start_at must be a valid date/time.'); vals.push(String(raw)); }
    sets.push(`auto_import_start_at = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'No settings provided.');
  vals.push(linkId, bookId);
  const row = await one(
    `UPDATE institution_links SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND book_id = $${vals.length} RETURNING id`,
    vals
  );
  if (!row) throw new HttpError(404, 'Connection not found.');
  res.json({ ok: true });
}));

// Toggle whether a single external account is included in this connection's scheduled
// auto-import (manual imports are unaffected — they pick accounts at import time).
connections.post('/:id/account-auto', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const linkId = integerId(req.params.id, 'id');
  const externalId = String(req.body?.external_account_id ?? '').trim();
  if (!externalId) throw new HttpError(400, 'external_account_id is required.');
  const autoImport = booleanValue(req.body?.auto_import, 'auto_import');
  const row = await one(
    `UPDATE account_links SET auto_import = $1 WHERE link_id = $2 AND external_account_id = $3 AND book_id = $4 RETURNING id`,
    [autoImport, linkId, externalId, bookId]
  );
  if (!row) throw new HttpError(404, 'Account not found.');
  res.json({ ok: true });
}));

// Validate an import request and resolve the chosen internal accounts to their
// external links, grouped by connection. Throws a clean 4xx on bad input.
async function resolveImport(req: any, bookId: number): Promise<{
  byLink: Map<number, { accessUrl: string; mapByExt: Map<string, number> }>;
  since: number; until: number | undefined;
}> {
  const accountIds: number[] = Array.isArray(req.body?.account_ids)
    ? req.body.account_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (!accountIds.length) throw new HttpError(400, 'Select at least one account to import.');
  const startDate = optionalDateOnly(req.body?.start_date, 'start_date');
  const endDate = optionalDateOnly(req.body?.end_date, 'end_date');

  const rows = await query<any>(
    `SELECT al.link_id, al.external_account_id, al.account_id, il.access_url_enc
       FROM account_links al JOIN institution_links il ON il.id = al.link_id
      WHERE al.book_id = $1 AND al.account_id = ANY($2) AND il.status <> 'revoked'`,
    [bookId, accountIds]
  );
  if (!rows.length) throw new HttpError(400, 'None of the selected accounts are linked to a SimpleFIN connection.');

  const nowS = Math.floor(Date.now() / 1000);
  const since = startDate ? Math.floor(Date.parse(startDate + 'T00:00:00Z') / 1000) : nowS - 30 * 86400;
  const until = endDate ? Math.floor(Date.parse(endDate + 'T23:59:59Z') / 1000) : undefined;

  const byLink = new Map<number, { accessUrl: string; mapByExt: Map<string, number> }>();
  for (const r of rows) {
    let g = byLink.get(r.link_id);
    if (!g) { g = { accessUrl: r.access_url_enc, mapByExt: new Map() }; byLink.set(r.link_id, g); }
    g.mapByExt.set(r.external_account_id, r.account_id);
  }
  return { byLink, since, until };
}

// Run a targeted import, optionally emitting progress events for a live (streamed)
// UI. The network fetch stays out of the DB transaction, and last_synced_at is left
// untouched, so a one-off historical import never creates a gap in the automatic sync.
async function runConnectionsImport(
  bookId: number, userId: number | null,
  byLink: Map<number, { accessUrl: string; mapByExt: Map<string, number> }>,
  since: number, until: number | undefined,
  onProgress?: (ev: any) => void,
): Promise<{ added: number; skipped: number; total: number }> {
  let added = 0, skipped = 0, total = 0, done = 0;
  const connections = byLink.size;
  for (const [linkId, g] of byLink) {
    onProgress?.({ type: 'status', message: connections > 1 ? `Connecting to bank ${done + 1} of ${connections}…` : 'Connecting to your bank…' });
    let pulled;
    try {
      pulled = await fetchAccounts(decryptSecret(g.accessUrl), { startDate: since, endDate: until });
    } catch (e: any) {
      await query(`UPDATE institution_links SET status = 'error', last_error = $2 WHERE id = $1 AND book_id = $3`,
        [linkId, String(e?.message ?? 'Import failed.').slice(0, 300), bookId]);
      done++;
      onProgress?.({ type: 'progress', connDone: done, connections, added, skipped, total, message: 'Connection error — skipped' });
      continue;
    }
    const txnCount = pulled.accounts.filter((a) => g.mapByExt.has(a.id)).reduce((s, a) => s + (a.transactions?.length ?? 0), 0);
    onProgress?.({ type: 'status', message: `Fetched ${txnCount} transaction${txnCount === 1 ? '' : 's'} — staging…` });
    const r = await withTransaction(async (client) => {
      const batch = (await client.query(
        `INSERT INTO import_batches (book_id, account_id, filename, source, total_rows, created_by)
         VALUES ($1, NULL, 'SimpleFIN import', 'simplefin', 0, $2) RETURNING id`,
        [bookId, userId]
      )).rows[0];
      const rr = await stageSimplefinTxns(client, bookId, linkId, batch.id, pulled.accounts, g.mapByExt);
      await client.query(`UPDATE import_batches SET total_rows = $2 WHERE id = $1`, [batch.id, rr.total]);
      for (const aid of rr.touched) await setImportStatus(client, bookId, aid, 'staged');
      await client.query(`UPDATE institution_links SET status = 'active', last_error = NULL WHERE id = $1 AND book_id = $2`, [linkId, bookId]);
      return rr;
    });
    if (r.balances.length) {
      const fmt = (n: number, cur: string) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n); } catch { return n.toFixed(2); } };
      const list = r.balances.map((b) => `${b.name} → ${fmt(b.balance, b.currency)}`).join(', ');
      onProgress?.({ type: 'status', message: `Updated ${r.balances.length} account balance${r.balances.length === 1 ? '' : 's'} to the latest: ${list}` });
    }
    added += r.added; skipped += r.skipped; total += r.total; done++;
    onProgress?.({ type: 'progress', connDone: done, connections, added, skipped, total, message: `Staged ${r.added} new · ${r.skipped} duplicate${r.skipped === 1 ? '' : 's'} skipped` });
  }
  return { added, skipped, total };
}

// JSON import (one shot; used programmatically and by the scheduled importer later).
connections.post('/import', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const { byLink, since, until } = await resolveImport(req, bookId);
  const r = await runConnectionsImport(bookId, req.user?.id ?? null, byLink, since, until);
  res.json(r);
}));

// Streaming import: the same work, but emits newline-delimited JSON progress events so
// the UI can show what the session is doing. Input validation still surfaces as a
// normal 4xx (thrown before any streaming begins).
connections.post('/import/stream', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const { byLink, since, until } = await resolveImport(req, bookId);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // don't let a proxy buffer the stream
  const send = (ev: any) => { res.write(JSON.stringify(ev) + '\n'); };

  send({ type: 'start', connections: byLink.size });
  try {
    const r = await runConnectionsImport(bookId, req.user?.id ?? null, byLink, since, until, send);
    send({ type: 'done', ...r });
  } catch (e: any) {
    send({ type: 'error', message: String(e?.message ?? 'Import failed.') });
  }
  res.end();
}));

// Remove a connection (cascades to its account_links; stored access URL is dropped).
connections.delete('/:id', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  await query(`DELETE FROM institution_links WHERE id = $1 AND book_id = $2`, [integerId(req.params.id, 'id'), bookId]);
  res.status(204).end();
}));
