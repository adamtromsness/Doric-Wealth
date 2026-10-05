import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { query, one, withTransaction, withBookContext, pool } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh, requireManager } from '../tenant.js';

export const backup = Router();

// Informational only — restore warns (but doesn't block) on a mismatch. Derived
// from the highest migration number on disk so it can't silently drift behind the
// schema (previously a hand-maintained constant that went stale). If the migrations
// directory isn't packaged with the runtime artifact we fall back to a baked value
// and warn loudly, rather than silently reporting version 0 (which would make every
// backup look schema-mismatched).
const FALLBACK_SCHEMA_VERSION = 98;
const SCHEMA_VERSION = (() => {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
    const nums = fs.readdirSync(dir)
      .filter((f) => /^\d{3}.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 3), 10))
      .filter((n) => !Number.isNaN(n));
    if (nums.length) return Math.max(...nums);
  } catch { /* fall through to the warning below */ }
  console.warn(`backup: migrations directory not found at runtime — using fallback SCHEMA_VERSION=${FALLBACK_SCHEMA_VERSION}. Ensure server/migrations is packaged with the deployment.`);
  return FALLBACK_SCHEMA_VERSION;
})();
const FORMAT_VERSION = 1;

// Identity / tenancy tables are NOT part of a book data backup. The scheduled-
// backup tables are excluded too, so a snapshot never recursively contains prior
// snapshots (or the schedule settings).
const EXCLUDED = new Set(['users', 'books', 'memberships', 'invites', 'sessions', 'backup_snapshots', 'book_backup_settings']);

// User-meaningful data sets, each bundling its tables. Any book table not
// listed here falls into a catch-all "other" group, so coverage stays complete
// as the schema grows.
const GROUPS: { key: string; label: string; tables: string[] }[] = [
  { key: 'accounts', label: 'Accounts & balances', tables: ['accounts', 'account_balances', 'account_balance_events', 'balance_adjustments', 'account_beneficiaries', 'account_documents', 'account_holdings', 'account_import_status', 'reconciliation_sessions', 'reconciliation_items'] },
  { key: 'transactions', label: 'Transactions', tables: ['transactions', 'transaction_splits', 'line_tags', 'receipts', 'receipt_items', 'staged_transactions', 'import_batches'] },
  { key: 'categories', label: 'Categories', tables: ['categories'] },
  { key: 'tags', label: 'Tags', tables: ['tags'] },
  { key: 'vehicles', label: 'Vehicles', tables: ['vehicles', 'vehicle_values', 'vehicle_odometer_readings', 'vehicle_maintenance', 'vehicle_warranties', 'vehicle_documents'] },
  { key: 'properties', label: 'Properties', tables: ['properties', 'property_values', 'property_maintenance', 'property_documents'] },
  { key: 'assets', label: 'Other assets', tables: ['assets', 'asset_values', 'asset_maintenance', 'asset_documents'] },
  { key: 'liabilities', label: 'Liabilities', tables: ['liabilities', 'liability_balances', 'liability_documents'] },
  { key: 'subscriptions', label: 'Subscriptions', tables: ['subscriptions', 'subscription_price_history', 'subscription_documents', 'ignored_subscription_merchants'] },
  { key: 'utilities', label: 'Utilities', tables: ['utility_accounts', 'utility_invoices', 'utility_invoice_lines', 'utility_invoice_payments', 'utility_bills', 'utility_account_documents'] },
  { key: 'insurance', label: 'Insurance policies', tables: ['insurance_policies'] },
  { key: 'budgets', label: 'Budgets', tables: ['budgets', 'budget_periods', 'budget_lines', 'budget_period_lines', 'budget_accounts'] },
  { key: 'goals', label: 'Goals', tables: ['goals'] },
  { key: 'ai', label: 'AI analyses', tables: ['ai_analyses'] },
];
const GROUP_OF: Record<string, string> = {};
for (const g of GROUPS) for (const t of g.tables) GROUP_OF[t] = g.key;
const groupOf = (t: string) => GROUP_OF[t] ?? 'other';

// Tables (from `all`) belonging to the selected group keys. null/empty = all.
function tablesForGroups(keys: string[] | null | undefined, all: string[]): string[] {
  if (!keys || keys.length === 0) return all;
  const set = new Set(keys);
  return all.filter((t) => set.has(groupOf(t)));
}
function parseGroups(q: any): string[] | null {
  if (typeof q !== 'string' || !q.trim()) return null;
  return q.split(',').map((s) => s.trim()).filter(Boolean);
}

interface TableMeta { columns: string[]; bytea: Set<string>; jsonb: Set<string>; selfRef: Set<string>; notNull: Set<string>; hasId: boolean }

// Every public table carrying a book_id (i.e. tenant data), minus identity.
// Foreign keys in the public schema, read from pg_catalog. information_schema's
// constraint views only list constraints on tables the current role OWNS, and the
// production app role owns none, so under it they come back empty (and restore would
// skip every id remap). `column`/`parent_col` are set for single-column FKs only.
type FkEdge = { child: string; parent: string; column: string | null; parent_col: string | null };
async function fkEdges(): Promise<FkEdge[]> {
  return query<FkEdge>(
    `SELECT ch.relname AS child, pa.relname AS parent,
            CASE WHEN cardinality(c.conkey) = 1 THEN a.attname END AS column,
            CASE WHEN cardinality(c.confkey) = 1 THEN af.attname END AS parent_col
       FROM pg_constraint c
       JOIN pg_class ch ON ch.oid = c.conrelid
       JOIN pg_class pa ON pa.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = ch.relnamespace AND n.nspname = 'public'
       LEFT JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = c.conkey[1]
       LEFT JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
      WHERE c.contype = 'f'`
  );
}

async function dataTables(): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'book_id' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name).filter((t) => !EXCLUDED.has(t));
}

async function tableMeta(tables: string[]): Promise<Record<string, TableMeta>> {
  const cols = await query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY ordinal_position`,
    [tables]
  );
  // Self-referencing FK columns (e.g. categories.parent_id) — inserted deferred.
  const selfRefs = (await fkEdges())
    .filter((e) => e.child === e.parent && e.column)
    .map((e) => ({ table_name: e.child, column_name: e.column! }));
  const meta: Record<string, TableMeta> = {};
  for (const t of tables) meta[t] = { columns: [], bytea: new Set(), jsonb: new Set(), selfRef: new Set(), notNull: new Set(), hasId: false };
  for (const c of cols) {
    const m = meta[c.table_name]; if (!m) continue;
    m.columns.push(c.column_name);
    if (c.column_name === 'id') m.hasId = true;
    if (c.data_type === 'bytea') m.bytea.add(c.column_name);
    if (c.data_type === 'jsonb' || c.data_type === 'json') m.jsonb.add(c.column_name);
    if (c.is_nullable === 'NO') m.notNull.add(c.column_name);
  }
  for (const s of selfRefs) meta[s.table_name]?.selfRef.add(s.column_name);
  return meta;
}

// Topological order (parents before children) from FK edges among `tables`.
async function topoOrder(tables: string[], extra: { child: string; parent: string }[] = []): Promise<string[]> {
  const set = new Set(tables);
  const edges = [...await fkEdges(), ...extra];
  const deps: Record<string, Set<string>> = {};
  for (const t of tables) deps[t] = new Set();
  for (const e of edges) if (set.has(e.child) && set.has(e.parent) && e.child !== e.parent) deps[e.child].add(e.parent);
  // Kahn's algorithm; ties broken alphabetically for determinism.
  const order: string[] = []; const done = new Set<string>();
  const remaining = [...tables].sort();
  let guard = 0;
  while (remaining.length && guard++ < tables.length + 2) {
    for (let i = 0; i < remaining.length;) {
      const t = remaining[i];
      if ([...deps[t]].every((p) => done.has(p))) { order.push(t); done.add(t); remaining.splice(i, 1); }
      else i++;
    }
  }
  // Any leftover (cycles via non-self edges) appended as-is.
  for (const t of remaining) order.push(t);
  return order;
}

// Cross-table FK columns (child column → referenced parent table) among `tables`,
// restricted to single-column FKs that reference the parent's `id`. Used on restore
// to remap a snapshot's old ids to the freshly-generated ones. Self-referential FKs
// are handled separately via TableMeta.selfRef.
async function fkColumns(tables: string[]): Promise<Record<string, { column: string; parent: string }[]>> {
  const set = new Set(tables);
  const rows = await fkEdges();
  const out: Record<string, { column: string; parent: string }[]> = {};
  for (const t of tables) out[t] = [];
  for (const r of rows) {
    if (!set.has(r.child) || !set.has(r.parent) || r.child === r.parent || r.parent_col !== 'id' || !r.column) continue;
    out[r.child].push({ column: r.column, parent: r.parent });
  }
  return out;
}

// References to another row's id that aren't declared foreign keys (one column can
// point at different tables depending on a "kind" column), so fkColumns can't see
// them. Restore remaps them like foreign keys. `deferred`: filled in after every
// table has loaded, because the parent also points back (subscriptions and utility
// accounts reference their managed category).
type PolyRef = { table: string; column: string; kindCol?: string; parents: string | Record<string, string>; deferred?: boolean };
const POLY_REFS: PolyRef[] = [
  { table: 'line_tags', column: 'ref_id', kindCol: 'kind', parents: { vehicle: 'vehicles', property: 'properties', tag: 'tags', subscription: 'subscriptions' } },
  { table: 'insurance_policies', column: 'entity_id', kindCol: 'entity_kind', parents: { vehicle: 'vehicles', property: 'properties', asset: 'assets' } },
  { table: 'ai_analyses', column: 'subject_id', kindCol: 'kind', parents: { vehicle_tco: 'vehicles', property_cost: 'properties' } },
  { table: 'asset_maintenance', column: 'transaction_id', parents: 'transactions' },
  { table: 'budget_period_lines', column: 'group_id', parents: 'categories' },
  { table: 'categories', column: 'source_id', kindCol: 'source_kind', parents: { utility: 'utility_accounts', subscription: 'subscriptions' }, deferred: true },
];
const polyParents = (p: PolyRef): string[] => (typeof p.parents === 'string' ? [p.parents] : Object.values(p.parents));
// The table a row's reference points at, or null for an unknown kind.
const polyParent = (p: PolyRef, row: any): string | null =>
  typeof p.parents === 'string' ? p.parents : (p.parents[String(row[p.kindCol!])] ?? null);

// --- Data sets and their current row counts (for the picker UI) ---------------
backup.get('/groups', ah(async (req, res) => {
  const bookId = hh(req);
  const all = await dataTables();
  const counts: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  for (const t of all) {
    // pg_column_size(row) approximates each row's stored bytes (incl. document blobs).
    const r = await one<{ c: number; b: number }>(
      `SELECT count(*)::int AS c, COALESCE(SUM(pg_column_size(x)), 0)::float8 AS b FROM "${t}" x WHERE book_id = $1`,
      [bookId]
    );
    counts[t] = r?.c ?? 0; bytes[t] = r?.b ?? 0;
  }
  const out: { key: string; label: string; rows: number; bytes: number }[] = [];
  for (const g of GROUPS) {
    const tabs = g.tables.filter((t) => all.includes(t));
    if (tabs.length) out.push({ key: g.key, label: g.label, rows: tabs.reduce((s, t) => s + (counts[t] ?? 0), 0), bytes: tabs.reduce((s, t) => s + (bytes[t] ?? 0), 0) });
  }
  const otherTabs = all.filter((t) => !GROUP_OF[t]);
  if (otherTabs.length) out.push({ key: 'other', label: 'Other', rows: otherTabs.reduce((s, t) => s + (counts[t] ?? 0), 0), bytes: otherTabs.reduce((s, t) => s + (bytes[t] ?? 0), 0) });
  res.json(out);
}));

// Stream the backup envelope as JSON to `write`, one piece at a time, so neither the
// full dataset nor the full serialized string is ever resident in memory. Rows are
// paged per table by id (keyset); bytea blobs are base64-encoded per row. The output
// is byte-for-byte the shape buildEnvelope used to produce as one string. Queries
// filter explicitly by book_id and run on the bound connection: the request's, or a
// background job's (withBookContext). Callers wrap it in one REPEATABLE READ
// transaction so every table/page sees the same committed state.
type EnvelopeWriter = (chunk: string) => void | Promise<void>;

async function streamEnvelope(bookId: number, groups: string[] | null, write: EnvelopeWriter): Promise<void> {
  const allTables = await dataTables();
  const tables = tablesForGroups(groups, allTables);
  const meta = await tableMeta(tables);
  const book = await one<{ id: number; name: string }>(`SELECT id, name FROM books WHERE id = $1`, [bookId]).catch(() => null);
  const header = {
    app: 'doric', format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION,
    book: book ?? { id: bookId, name: null },
    exported_at: new Date().toISOString(),
  };
  // Emit the header object, then reopen it to stream "tables" as the final key.
  await write(JSON.stringify(header).slice(0, -1) + ',"tables":{');

  let firstTable = true;
  for (const t of tables) {
    await write(`${firstTable ? '' : ','}${JSON.stringify(t)}:[`);
    firstTable = false;
    const bytea = meta[t].bytea;
    // Smaller batches for blob-bearing tables (receipt images / documents) so a
    // single batch's base64 strings can't balloon memory.
    const batchSize = bytea.size ? 25 : 500;
    let firstRow = true;
    const emit = async (rows: any[]) => {
      for (const row of rows) {
        if (bytea.size) for (const c of bytea) if (row[c] != null && Buffer.isBuffer(row[c])) row[c] = (row[c] as Buffer).toString('base64');
        await write(`${firstRow ? '' : ','}${JSON.stringify(row)}`);
        firstRow = false;
      }
    };
    if (meta[t].hasId) {
      let after = 0;
      for (;;) {
        const rows = await query(`SELECT * FROM "${t}" WHERE book_id = $1 AND id > $2 ORDER BY id LIMIT ${batchSize}`, [bookId, after]);
        if (!rows.length) break;
        await emit(rows);
        after = rows[rows.length - 1].id;
        if (rows.length < batchSize) break;
      }
    } else {
      // No surrogate id to page on — these are small junction tables; load once.
      await emit(await query(`SELECT * FROM "${t}" WHERE book_id = $1`, [bookId]));
    }
    await write(']');
  }
  await write('}}');
}

// Build the whole envelope as one JSON string (used by the snapshot store, which
// persists it as a single value). Shares the exact serializer with the streaming
// export so the two can never drift apart.
export async function buildEnvelope(bookId: number, groups: string[] | null): Promise<string> {
  const parts: string[] = [];
  await streamEnvelope(bookId, groups, (c) => { parts.push(c); });
  return parts.join('');
}

// Backpressure-aware writer for an Express response: only awaits 'drain' when the
// socket's buffer is full, so a huge export streams out instead of buffering whole.
function makeResWriter(res: any): EnvelopeWriter {
  return (chunk: string) => {
    if (res.write(chunk)) return;
    return new Promise<void>((resolve) => res.once('drain', resolve));
  };
}

// --- Export: download a snapshot (all data, or only the selected groups) -------
backup.get('/export', ah(async (req, res) => {
  requireManager(req); // Exporting the full book dataset is owner/admin-only.
  const bookId = hh(req);
  const groups = parseGroups(req.query.groups);
  // Optional label distinguishes e.g. the automatic pre-restore safety snapshot.
  const label = typeof req.query.label === 'string' && /^[a-z0-9-]{1,32}$/.test(req.query.label) ? req.query.label : 'backup';
  const fname = `doric-${label}-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  try {
    // One REPEATABLE READ, READ ONLY transaction: every table and page reads the same
    // committed state, so concurrent edits can't produce a mixed or dangling export.
    // A slow download keeps the transaction open between writes, so allow longer idle
    // gaps than the pool's 60s default for this transaction only.
    await withTransaction(async (client) => {
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '15min'`);
      await streamEnvelope(bookId, groups, makeResWriter(res));
    }, { isolation: 'repeatable read', readOnly: true });
    res.end();
  } catch (e) {
    // Headers and part of the body are already on the wire, so we can't switch to a
    // clean JSON error — abort the connection so the client gets a truncated (clearly
    // invalid) download rather than a silently partial file that looks complete.
    console.error('backup export failed mid-stream:', e);
    res.destroy();
  }
}));

function validateEnvelope(env: any): void {
  // Accept both the current 'doric' marker and legacy 'ledger' exports (pre-rebrand).
  if (!env || typeof env !== 'object' || (env.app !== 'doric' && env.app !== 'ledger') || env.format_version !== FORMAT_VERSION || typeof env.tables !== 'object') {
    throw new HttpError(400, 'This is not a valid Doric backup file.');
  }
}

// Validate a snapshot envelope and summarize what it contains and what restoring it
// would replace (no writes).
async function previewEnvelope(bookId: number, env: any) {
  validateEnvelope(env);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [t, rows] of Object.entries(env.tables as Record<string, any[]>)) {
    if (Array.isArray(rows) && rows.length) { counts[t] = rows.length; total += rows.length; }
  }
  const plan = await planRestore(bookId, env);
  return {
    book: env.book ?? null,
    exported_at: env.exported_at ?? null,
    schema_version: env.schema_version ?? null,
    schema_mismatch: env.schema_version !== SCHEMA_VERSION,
    total_rows: total,
    counts,
    // What a restore would do: the data sets it replaces, how many current records
    // those hold (all removed), and anything that stops it.
    replaces: plan.groups.map(groupLabel),
    current_rows: plan.currentRows,
    problems: plan.problems,
  };
}

// --- Preview: validate a snapshot and report what it contains (no writes) -----
backup.post('/preview', ah(async (req, res) => {
  res.json(await previewEnvelope(hh(req), req.body));
}));

interface RestorePlan {
  snapTables: string[];   // tables with rows (or an empty list) in the snapshot
  replace: string[];      // every table a restore wipes: all tables of the data sets the snapshot covers
  groups: string[];       // those data sets
  problems: string[];     // reasons the restore can't go ahead (empty = safe)
  currentRows: number;    // current records in `replace`
  liveIds: (table: string) => Promise<Set<number>>;
}

// Work out what restoring `env` into the book replaces, and whether that's safe. A
// backup covers the data sets it has tables for (a newer table it predates counts as
// empty), and a restore replaces those data sets whole. A selective backup leaves the
// other data sets alone, so it can't go ahead if:
//   - rows outside it point at rows it replaces (e.g. transactions at accounts, or a
//     bank link at an account): replacing those would unlink or delete them; or
//   - its rows need a row outside it that this book doesn't have (a required link).
// Links from restored rows to rows outside it are kept when this book still has that
// row (a backup of this book), and otherwise dropped.
async function planRestore(bookId: number, env: any): Promise<RestorePlan> {
  const allTables = await dataTables();
  const meta = await tableMeta(allTables);
  const snapshot: Record<string, any[]> = env.tables;
  const snapTables = allTables.filter((t) => Array.isArray(snapshot[t]));
  const covered = new Set(snapTables.map(groupOf));
  const replace = allTables.filter((t) => covered.has(groupOf(t)));
  const replaceSet = new Set(replace);
  const groups = [...GROUPS.map((g) => g.key), 'other'].filter((g) => covered.has(g));

  const cache = new Map<string, Set<number>>();
  const liveIds = async (t: string) => {
    let ids = cache.get(t);
    if (!ids) {
      ids = new Set((await query<{ id: number }>(`SELECT id FROM "${t}" WHERE book_id = $1`, [bookId])).map((r) => Number(r.id)));
      cache.set(t, ids);
    }
    return ids;
  };

  const problems: string[] = [];
  // Rows outside the backup that point into what it replaces, by data set.
  const outward = new Map<string, number>();
  // Links between book data tables. (Links to users are kept as they are.)
  const edges = (await fkEdges()).filter((e) => e.column && e.parent_col === 'id' && e.child !== e.parent && meta[e.child] && meta[e.parent]);
  for (const e of edges) {
    if (replaceSet.has(e.child) || !replaceSet.has(e.parent) || !meta[e.child]) continue;
    const n = (await one<{ c: number }>(`SELECT count(*)::int AS c FROM "${e.child}" WHERE book_id = $1 AND "${e.column}" IS NOT NULL`, [bookId]))!.c;
    if (n) outward.set(groupOf(e.child), (outward.get(groupOf(e.child)) ?? 0) + n);
  }
  for (const p of POLY_REFS) {
    if (replaceSet.has(p.table) || !meta[p.table]) continue;
    const targets = typeof p.parents === 'string'
      ? (replaceSet.has(p.parents) ? [null] : [])
      : Object.entries(p.parents).filter(([, t]) => replaceSet.has(t)).map(([k]) => k);
    for (const kind of targets) {
      const n = kind == null
        ? (await one<{ c: number }>(`SELECT count(*)::int AS c FROM "${p.table}" WHERE book_id = $1 AND "${p.column}" IS NOT NULL`, [bookId]))!.c
        : (await one<{ c: number }>(`SELECT count(*)::int AS c FROM "${p.table}" WHERE book_id = $1 AND "${p.column}" IS NOT NULL AND "${p.kindCol}" = $2`, [bookId, kind]))!.c;
      if (n) outward.set(groupOf(p.table), (outward.get(groupOf(p.table)) ?? 0) + n);
    }
  }
  if (outward.size) {
    const list = [...outward].map(([g, n]) => `${n.toLocaleString('en-US')} in ${groupLabel(g)}`).join(', ');
    problems.push(`Restoring only ${groups.map(groupLabel).join(', ')} would unlink or delete records that point at it (${list}). Restore a full backup instead.`);
  }

  // Required links from the backup's rows to rows outside it that this book lacks.
  const missing = new Set<string>();
  for (const t of snapTables) {
    const rows = snapshot[t];
    if (!rows.length) continue;
    for (const e of edges) {
      if (e.child !== t || replaceSet.has(e.parent) || !meta[t].notNull.has(e.column!)) continue;
      const ids = await liveIds(e.parent);
      if (rows.some((r) => r[e.column!] != null && !ids.has(Number(r[e.column!])))) missing.add(groupLabel(groupOf(e.parent)));
    }
  }
  if (missing.size) {
    problems.push(`This selective restore depends on data sets that aren't in the backup: ${[...missing].join(', ')}. Include those data sets, or restore a full backup.`);
  }

  let currentRows = 0;
  for (const t of replace) currentRows += (await one<{ c: number }>(`SELECT count(*)::int AS c FROM "${t}" WHERE book_id = $1`, [bookId]))!.c;
  return { snapTables, replace, groups, problems, currentRows, liveIds };
}

// REPLACE the active book's data with the snapshot envelope. Destructive:
// deletes the data sets the snapshot covers and loads the snapshot in a single
// transaction (rolls back on any error). Shared by file-upload restore and
// stored-snapshot restore. Refuses (before changing anything) when planRestore finds
// a problem.
async function restoreEnvelope(bookId: number, env: any): Promise<{ restored_rows: number; tables: number }> {
  validateEnvelope(env);
  const allTables = await dataTables();
  const meta = await tableMeta(allTables);
  const snapshot: Record<string, any[]> = env.tables;
  const polyEdges = POLY_REFS.filter((p) => !p.deferred).flatMap((p) => polyParents(p).map((parent) => ({ child: p.table, parent })));
  const topo = await topoOrder(allTables, polyEdges);
  const fks = await fkColumns(allTables);
  const polyOf = new Map(POLY_REFS.map((p) => [p.table, p] as const));

  let inserted = 0;
  let loaded = 0;
  await withTransaction(async (client) => {
    const plan = await planRestore(bookId, env);
    if (plan.problems.length) throw new HttpError(400, plan.problems.join(' '));
    const replaceSet = new Set(plan.replace);
    const order = topo.filter((t) => plan.snapTables.includes(t));
    // old-id → new-id per replaced table, so the snapshot's ids are never trusted:
    // every primary key is regenerated by the DB and every reference remapped.
    const idMap: Record<string, Map<number, number>> = {};
    for (const t of plan.replace) idMap[t] = new Map();
    // Resolve a reference from a restored row: into a replaced table via the id map;
    // to a row outside the restore only if this book has it. null = unresolved.
    const resolve = async (parent: string, v: any): Promise<number | null> => {
      if (replaceSet.has(parent)) return idMap[parent].get(Number(v)) ?? null;
      return (await plan.liveIds(parent)).has(Number(v)) ? Number(v) : null;
    };
    const deferredRefs: { table: string; column: string; parent: string; newId: number; oldVal: number }[] = [];

    // Wipe the replaced data sets for this book, children first (RLS-scoped).
    for (const t of [...topo].reverse()) {
      if (replaceSet.has(t)) await client.query(`DELETE FROM "${t}" WHERE book_id = $1`, [bookId]);
    }
    // Load snapshot, parents first. The DB assigns fresh ids; references are
    // remapped to those new ids (parents load first, so their map is ready), and
    // self-references are resolved in a second pass once the table's map is full.
    // Result: a crafted snapshot cannot inject arbitrary primary keys, collide with
    // another book's id space, or re-point references at unrelated rows.
    for (const t of order) {
      const rows = snapshot[t];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      loaded++;
      const m = meta[t];
      const colSet = new Set(m.columns);
      const fkByCol = new Map((fks[t] ?? []).map((f) => [f.column, f.parent] as const));
      const poly = polyOf.get(t);
      const selfRefUpdates: { newId: number; pending: { col: string; oldVal: number }[] }[] = [];

      // Prepare every row's insert columns + values up front, then write them in
      // chunked multi-row INSERTs. A row whose required reference can't be resolved
      // (only possible in a damaged or hand-edited file) is skipped.
      type Prepared = { cols: string[]; vals: any[]; oldId: number | null; pending: { col: string; oldVal: number }[]; deferred: { parent: string; oldVal: number } | null };
      const prepared: Prepared[] = [];
      for (const row of rows) {
        const insCols: string[] = []; const vals: any[] = [];
        let skip = false;
        let deferred: Prepared['deferred'] = null;
        for (const c of m.columns) {
          if (c === 'id') continue; // always let the DB assign a fresh primary key
          if (!(c in row)) continue;
          let v = c === 'book_id' ? bookId : row[c];
          if (m.selfRef.has(c) && v != null) continue; // deferred → resolved below
          if (v != null && fkByCol.has(c)) v = await resolve(fkByCol.get(c)!, v);
          else if (v != null && poly && c === poly.column) {
            const parent = polyParent(poly, row);
            if (poly.deferred) { if (parent) deferred = { parent, oldVal: Number(v) }; v = null; }
            else v = parent ? await resolve(parent, v) : null;
          }
          if (v == null && row[c] != null && m.notNull.has(c)) { skip = true; break; }
          if (v != null && m.bytea.has(c)) v = Buffer.from(String(v), 'base64');
          if (v != null && m.jsonb.has(c) && typeof v === 'object') v = JSON.stringify(v);
          insCols.push(c); vals.push(v);
        }
        if (skip) continue;
        const pending: { col: string; oldVal: number }[] = [];
        if (m.selfRef.size) for (const c of m.selfRef) if (c in row && row[c] != null && colSet.has(c)) pending.push({ col: c, oldVal: Number(row[c]) });
        prepared.push({ cols: insCols, vals, oldId: row.id != null ? Number(row.id) : null, pending, deferred });
      }

      // Group rows by their exact column signature so each multi-row INSERT's VALUES all
      // line up (our exports are uniform, but a self-ref column is present only on rows
      // whose value is null — that splits cleanly into groups). RETURNING on a multi-row
      // VALUES comes back in row order, so new ids correlate positionally.
      const ret = m.hasId ? ' RETURNING id' : '';
      const groups = new Map<string, Prepared[]>();
      for (const p of prepared) {
        const key = p.cols.join('|');
        let g = groups.get(key); if (!g) { g = []; groups.set(key, g); }
        g.push(p);
      }
      const track = (p: Prepared, newId: number | null) => {
        if (newId == null) return;
        if (p.oldId != null) idMap[t].set(p.oldId, newId);
        if (p.pending.length) selfRefUpdates.push({ newId, pending: p.pending });
        if (p.deferred && poly) deferredRefs.push({ table: t, column: poly.column, parent: p.deferred.parent, newId, oldVal: p.deferred.oldVal });
      };
      for (const grp of groups.values()) {
        const cols = grp[0].cols;
        if (!cols.length) { // no insertable columns → let every default apply
          for (const p of grp) {
            const res = await client.query(`INSERT INTO "${t}" DEFAULT VALUES${ret}`);
            inserted++;
            track(p, m.hasId ? (res.rows[0] as any)?.id ?? null : null);
          }
          continue;
        }
        const colSql = cols.map((c) => `"${c}"`).join(',');
        const perChunk = Math.max(1, Math.floor(60000 / cols.length)); // stay under the 65535 param cap
        for (let i = 0; i < grp.length; i += perChunk) {
          const chunk = grp.slice(i, i + perChunk);
          const params: any[] = [];
          const tuples = chunk.map((p) => `(${p.vals.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
          const res = await client.query(`INSERT INTO "${t}" (${colSql}) VALUES ${tuples.join(',')}${ret}`, params);
          inserted += chunk.length;
          if (m.hasId) for (let j = 0; j < chunk.length; j++) track(chunk[j], (res.rows[j] as any)?.id ?? null);
        }
      }
      // Resolve deferred self-references now that this table's id map is complete.
      for (const u of selfRefUpdates) {
        const sets: string[] = []; const uvals: any[] = [];
        for (const p of u.pending) { sets.push(`"${p.col}" = $${uvals.length + 1}`); uvals.push(idMap[t].get(p.oldVal) ?? null); }
        uvals.push(u.newId);
        await client.query(`UPDATE "${t}" SET ${sets.join(', ')} WHERE id = $${uvals.length}`, uvals);
      }
      // No setval needed: ids come from the live sequence, which self-advances.
    }
    // References that point back at a table loaded later (see POLY_REFS).
    for (const d of deferredRefs) {
      const v = await resolve(d.parent, d.oldVal);
      if (v != null) await client.query(`UPDATE "${d.table}" SET "${d.column}" = $1 WHERE id = $2 AND book_id = $3`, [v, d.newId, bookId]);
    }
  });

  return { restored_rows: inserted, tables: loaded };
}

// --- Import: restore from an uploaded snapshot file ---------------------------
backup.post('/import', ah(async (req, res) => {
  requireManager(req); // Restore wipes and reloads the book — owner/admin-only.
  if (req.body?.confirm !== 'REPLACE') throw new HttpError(400, "Restore must be confirmed with confirm: 'REPLACE'.");
  const result = await restoreEnvelope(hh(req), req.body);
  res.json({ ok: true, ...result });
}));

// --- Purge: delete rows in the selected data sets created within a date range -
// Filters on each row's DB creation timestamp (created_at) — i.e. WHEN the record was
// added to the ledger, NOT the business date on the transaction/account/etc. Tables
// without a created_at column aren't directly purged (their child rows are removed via
// FK cascade when a dated parent is deleted). Destructive; transactional; needs confirm.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function purgeRange(body: any): { from: string | null; to: string | null } {
  const norm = (v: any): string | null => {
    const s = (v == null ? '' : String(v)).trim();
    if (!s) return null;
    if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, 'Dates must be in YYYY-MM-DD form.');
    return s;
  };
  const from = norm(body?.from), to = norm(body?.to);
  if (from && to && from > to) throw new HttpError(400, 'The "from" date must be on or before the "to" date.');
  return { from, to };
}
// Appends created_at bounds to a query, pushing params; `to` is inclusive of its whole day.
function rangeClause(from: string | null, to: string | null, params: any[]): string {
  let sql = '';
  if (from) { params.push(from); sql += ` AND created_at >= $${params.length}::date`; }
  if (to) { params.push(to); sql += ` AND created_at < ($${params.length}::date + 1)`; }
  return sql;
}
async function tablesWithCreatedAt(tables: string[]): Promise<Set<string>> {
  if (!tables.length) return new Set();
  const rows = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'created_at' AND table_name = ANY($1)`,
    [tables]
  );
  return new Set(rows.map((r) => r.table_name));
}
const groupLabel = (k: string): string => GROUPS.find((g) => g.key === k)?.label ?? (k === 'other' ? 'Other' : k);

// Preview: how many rows each selected data set would lose in the range (no writes).
backup.post('/purge/preview', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const keys: string[] = Array.isArray(req.body?.groups) ? req.body.groups.map(String) : [];
  if (!keys.length) throw new HttpError(400, 'Select at least one data set.');
  const { from, to } = purgeRange(req.body);
  const allTables = await dataTables();
  const tables = tablesForGroups(keys, allTables);
  const dated = await tablesWithCreatedAt(tables);
  const perGroup: Record<string, number> = {};
  for (const t of tables) {
    if (!dated.has(t)) continue;
    const params: any[] = [bookId];
    const r = await one<{ c: number }>(`SELECT count(*)::int AS c FROM "${t}" WHERE book_id = $1${rangeClause(from, to, params)}`, params);
    const g = groupOf(t);
    perGroup[g] = (perGroup[g] ?? 0) + (r?.c ?? 0);
  }
  const out = keys.map((k) => ({ key: k, label: groupLabel(k), rows: perGroup[k] ?? 0 }));
  const total = out.reduce((s, g) => s + g.rows, 0);
  res.json({ groups: out, total_rows: total, from, to });
}));

backup.post('/purge', ah(async (req, res) => {
  requireManager(req); // Permanent deletion — owner/admin-only.
  const bookId = hh(req);
  const keys: string[] = Array.isArray(req.body?.groups) ? req.body.groups.map(String) : [];
  if (req.body?.confirm !== 'DELETE') throw new HttpError(400, "Purge must be confirmed with confirm: 'DELETE'.");
  if (!keys.length) throw new HttpError(400, 'Select at least one data set to delete.');
  const { from, to } = purgeRange(req.body);

  const allTables = await dataTables();
  const tables = tablesForGroups(keys, allTables);
  if (!tables.length) throw new HttpError(400, 'Nothing matched the selected data sets.');
  const dated = await tablesWithCreatedAt(tables);
  const order = (await topoOrder(allTables)).filter((t) => tables.includes(t) && dated.has(t));

  let deleted = 0;
  try {
    await withTransaction(async (client) => {
      // Children first so a dated parent isn't blocked by its own in-range children.
      for (const t of [...order].reverse()) {
        const params: any[] = [bookId];
        const r = await client.query(`DELETE FROM "${t}" WHERE book_id = $1${rangeClause(from, to, params)}`, params);
        deleted += r.rowCount ?? 0;
      }
    });
  } catch (e: any) {
    if (e?.code === '23503') throw new HttpError(409, 'Some records in this range are still referenced by data outside it (e.g. transactions linked to an account). Widen the range or include the related data set.');
    throw e;
  }
  res.json({ ok: true, deleted_rows: deleted, groups: keys, from, to });
}));

// --- Scheduled backups -------------------------------------------------------
// A scheduled backup runs server-side with no browser present, so it can't trigger a
// download. Instead the job stores each snapshot here; the user retrieves them from the
// list below. Mirrors the SimpleFIN auto-import schedule (start anchor + frequency).

const FREQS = new Set(['daily', 'weekly']);
// Snapshots are a small curated set. Once over the cap, the oldest *unpinned* snapshot
// is auto-purged to make room; if every slot is pinned, a new snapshot is refused.
const MAX_SNAPSHOTS = 5;

interface BackupSettings { enabled: boolean; frequency: string; start_at: string | null; groups: string[] | null; retain: number; last_backup_at: string | null }

// Comma-separated group keys ↔ array; NULL/'' means "all data sets".
const parseGroupList = (s: string | null): string[] | null => {
  const list = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : null;
};

async function readSettings(bookId: number): Promise<BackupSettings> {
  const r = await one<any>(
    `SELECT enabled, frequency, retain, groups,
            to_char(start_at,       'YYYY-MM-DD"T"HH24:MI') AS start_at,
            to_char(last_backup_at, 'YYYY-MM-DD"T"HH24:MI') AS last_backup_at
       FROM book_backup_settings WHERE book_id = $1`,
    [bookId]
  );
  if (!r) return { enabled: false, frequency: 'weekly', start_at: null, groups: null, retain: 14, last_backup_at: null };
  return { ...r, groups: parseGroupList(r.groups) };
}

backup.get('/schedule', ah(async (req, res) => {
  res.json(await readSettings(hh(req)));
}));

backup.post('/schedule', ah(async (req, res) => {
  requireManager(req); // Owner/admin-only: this governs full-dataset snapshots.
  const bookId = hh(req);
  const b = req.body ?? {};
  const enabled = !!b.enabled;
  const frequency = FREQS.has(b.frequency) ? b.frequency : 'weekly';
  let startAt: string | null = null;
  if (b.start_at != null && String(b.start_at).trim()) {
    if (Number.isNaN(Date.parse(String(b.start_at)))) throw new HttpError(400, 'Invalid start date/time.');
    startAt = String(b.start_at);
  }
  // null/empty/"all selected" → store NULL (full snapshot); otherwise the chosen keys.
  const groups = Array.isArray(b.groups) && b.groups.length
    ? [...new Set(b.groups.map(String).map((s: string) => s.trim()).filter(Boolean))].join(',') || null
    : null;
  await query(
    `INSERT INTO book_backup_settings (book_id, enabled, frequency, start_at, groups, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (book_id) DO UPDATE
        SET enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency,
            start_at = EXCLUDED.start_at, groups = EXCLUDED.groups, updated_at = now()`,
    [bookId, enabled, frequency, startAt, groups]
  );
  res.json(await readSettings(bookId));
}));

const snapName = (s: string | null | undefined, fallback: string): string => {
  const v = (s ?? '').trim();
  return v ? v.slice(0, 80) : fallback;
};

// List stored snapshots (metadata only — the JSON blob is fetched on download).
// taken_at is when the data was captured (ISO) — equals the upload's ORIGINAL creation
// time for uploaded files, not when it was added here.
backup.get('/snapshots', ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT id, created_at, taken_at, name, label, scope, pinned, bytes::float8 AS bytes, schema_version
       FROM backup_snapshots WHERE book_id = $1
      ORDER BY pinned DESC, taken_at DESC, id DESC`,
    [hh(req)]
  );
  res.json({ snapshots: rows, max: MAX_SNAPSHOTS });
}));

interface StoreOpts { name: string; label: string; full: boolean; takenAt?: string | null; schemaVersion?: number }

// Insert one snapshot and enforce the cap: drop the oldest unpinned snapshots beyond
// MAX_SNAPSHOTS. If the book is already at the cap with every slot pinned, refuse
// (there's nothing safe to purge). Runs inside the caller's transaction/`client`.
async function storeSnapshot(client: any, bookId: number, body: string, opts: StoreOpts): Promise<number> {
  const { name, label, full, takenAt = null, schemaVersion = SCHEMA_VERSION } = opts;
  const data = Buffer.from(body, 'utf8');
  const before = (await client.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE pinned)::int AS pinned
       FROM backup_snapshots WHERE book_id = $1`, [bookId]
  )).rows[0];
  if (before.total >= MAX_SNAPSHOTS && before.total - before.pinned === 0) {
    throw new HttpError(409, `You can keep at most ${MAX_SNAPSHOTS} snapshots and all of them are pinned. Unpin or delete one first.`);
  }
  const ins = await client.query(
    `INSERT INTO backup_snapshots (book_id, name, label, scope, pinned, bytes, schema_version, taken_at, data)
          VALUES ($1, $2, $3, $4, false, $5, $6, COALESCE($7::timestamptz, now()), $8) RETURNING id`,
    [bookId, name, label, full ? 'full' : 'partial', data.length, schemaVersion, takenAt, data]
  );
  const total = (await client.query(`SELECT count(*)::int AS c FROM backup_snapshots WHERE book_id = $1`, [bookId])).rows[0].c;
  const excess = total - MAX_SNAPSHOTS;
  if (excess > 0) {
    await client.query(
      `DELETE FROM backup_snapshots WHERE id IN (
         SELECT id FROM backup_snapshots
          WHERE book_id = $1 AND pinned = false
          ORDER BY id ASC LIMIT $2)`,
      [bookId, excess]
    );
  }
  return ins.rows[0].id;
}

// Create a snapshot right now (stored in the DB alongside the scheduled ones).
backup.post('/snapshots', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const groups = parseGroupList(Array.isArray(req.body?.groups) ? req.body.groups.map(String).join(',') : null);
  const name = snapName(req.body?.name, 'Manual snapshot');
  // Build and store in one REPEATABLE READ transaction: a consistent view of the book.
  const id = await withTransaction(async (client) => {
    const body = await buildEnvelope(bookId, groups);
    return storeSnapshot(client, bookId, body, { name, label: 'manual', full: groups == null });
  }, { isolation: 'repeatable read' });
  res.json({ ok: true, id });
}));

// Upload a snapshot file and add it to the list (no restore). Validates it's a real
// Ledger backup, then stores it like any other snapshot (subject to the cap). Its
// recorded creation time (taken_at) and scope come from the file itself, so an old
// backup shows when it was actually made.
backup.post('/snapshots/upload', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const env = req.body?.envelope;
  validateEnvelope(env);
  const name = snapName(req.body?.name, 'Uploaded snapshot');
  const schemaVersion = Number.isInteger(env?.schema_version) ? env.schema_version : SCHEMA_VERSION;
  const takenAt = typeof env.exported_at === 'string' && !Number.isNaN(Date.parse(env.exported_at)) ? env.exported_at : null;
  const allTables = await dataTables();
  const present = new Set(Object.keys(env.tables ?? {}));
  const full = allTables.every((t) => present.has(t));
  const id = await withTransaction((client) => storeSnapshot(client, bookId, JSON.stringify(env), { name, label: 'upload', full, takenAt, schemaVersion }));
  res.json({ ok: true, id });
}));

// Rename / pin / unpin a snapshot. At most MAX_PINNED snapshots stay pinned, so there's
// always an unpinned slot the cap can auto-purge — pinning one more unpins the oldest
// of the others (never the one just pinned).
const MAX_PINNED = MAX_SNAPSHOTS - 1; // = 4
backup.patch('/snapshots/:id', ah(async (req, res) => {
  requireManager(req);
  const bookId = hh(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad snapshot id.');
  const sets: string[] = []; const vals: any[] = [];
  if (typeof req.body?.name === 'string') { sets.push(`name = $${vals.length + 1}`); vals.push(snapName(req.body.name, 'Snapshot')); }
  if (typeof req.body?.pinned === 'boolean') { sets.push(`pinned = $${vals.length + 1}`); vals.push(req.body.pinned); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  vals.push(id, bookId);
  await query(`UPDATE backup_snapshots SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND book_id = $${vals.length}`, vals);

  let unpinned: string[] = [];
  if (req.body?.pinned === true) {
    // Keep the just-pinned one plus the (MAX_PINNED - 1) most-recent other pins; unpin
    // any older pinned snapshots beyond that (normally just the single oldest).
    const rows = await query<{ name: string | null }>(
      `UPDATE backup_snapshots SET pinned = false
        WHERE book_id = $1 AND pinned = true AND id <> $2
          AND id NOT IN (
            SELECT id FROM backup_snapshots
             WHERE book_id = $1 AND pinned = true AND id <> $2
             ORDER BY id DESC LIMIT $3)
        RETURNING name`,
      [bookId, id, MAX_PINNED - 1]
    );
    unpinned = rows.map((r) => r.name ?? 'Untitled');
  }
  res.json({ ok: true, unpinned });
}));

// Download one stored snapshot as a file.
backup.get('/snapshots/:id/download', ah(async (req, res) => {
  requireManager(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad snapshot id.');
  const row = await one<{ data: Buffer; created_at: string; name: string | null; label: string }>(
    `SELECT data, to_char(created_at, 'YYYY-MM-DD') AS created_at, name, label
       FROM backup_snapshots WHERE id = $1 AND book_id = $2`,
    [id, hh(req)]
  );
  if (!row) throw new HttpError(404, 'Snapshot not found.');
  const slug = (row.name ?? row.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'snapshot';
  const fname = `doric-${slug}-${row.created_at}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(row.data);
}));

// Load a stored snapshot's envelope (helper for preview/restore from the list).
async function loadSnapshotEnvelope(bookId: number, id: number): Promise<any> {
  const row = await one<{ data: Buffer }>(`SELECT data FROM backup_snapshots WHERE id = $1 AND book_id = $2`, [id, bookId]);
  if (!row) throw new HttpError(404, 'Snapshot not found.');
  try { return JSON.parse(row.data.toString('utf8')); }
  catch { throw new HttpError(422, 'This snapshot is corrupted and cannot be read.'); }
}

// Preview a stored snapshot (what restoring it would replace).
backup.post('/snapshots/:id/preview', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad snapshot id.');
  const bookId = hh(req);
  res.json(await previewEnvelope(bookId, await loadSnapshotEnvelope(bookId, id)));
}));

// Restore the active book from a stored snapshot.
backup.post('/snapshots/:id/restore', ah(async (req, res) => {
  requireManager(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad snapshot id.');
  if (req.body?.confirm !== 'REPLACE') throw new HttpError(400, "Restore must be confirmed with confirm: 'REPLACE'.");
  const bookId = hh(req);
  const env = await loadSnapshotEnvelope(bookId, id);
  const result = await restoreEnvelope(bookId, env);
  res.json({ ok: true, ...result });
}));

backup.delete('/snapshots/:id', ah(async (req, res) => {
  requireManager(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad snapshot id.');
  await query(`DELETE FROM backup_snapshots WHERE id = $1 AND book_id = $2`, [id, hh(req)]);
  res.json({ ok: true });
}));

// Generate and store one scheduled snapshot for a book, enforcing the cap. Runs in
// the book's tenant context (no HTTP request in scope) and in one REPEATABLE READ
// transaction, so the snapshot is a consistent view of the book and is stored, with
// last_backup_at, atomically: a failure stores nothing and leaves the book due.
async function runBookBackup(bookId: number, groups: string[] | null): Promise<void> {
  await withBookContext(bookId, async (client) => {
    const body = await buildEnvelope(bookId, groups);
    await storeSnapshot(client, bookId, body, { name: 'Scheduled snapshot', label: 'auto', full: groups == null });
    await client.query(`UPDATE book_backup_settings SET last_backup_at = now() WHERE book_id = $1`, [bookId]);
  }, { isolation: 'repeatable read' });
}

// Background entry point: find books whose schedule is due and back each one up.
// Same "aligned to the chosen time-of-day" due logic as the SimpleFIN auto-import.
export async function runDueBackupsSafe(): Promise<void> {
  try {
    // book_backup_settings is under row-level security, so read each book's settings in
    // that book's context; `books` itself isn't, so enumerate it directly.
    const books = (await pool.query(`SELECT id FROM books ORDER BY id`)).rows as { id: number }[];
    const rows: any[] = [];
    for (const b of books) {
      const r = await withBookContext(b.id, () => one<any>(
        `SELECT book_id, frequency, groups,
                EXTRACT(EPOCH FROM last_backup_at)::bigint AS last_epoch,
                EXTRACT(EPOCH FROM COALESCE(start_at, updated_at))::bigint AS start_epoch
           FROM book_backup_settings WHERE book_id = $1 AND enabled = true`,
        [b.id]
      ), { readOnly: true });
      if (r) rows.push(r);
    }
    const nowS = Math.floor(Date.now() / 1000);
    for (const s of rows) {
      const start = Number(s.start_epoch);
      if (nowS < start) continue; // schedule hasn't started yet
      const period = s.frequency === 'weekly' ? 7 * 86400 : 86400;
      const lastFire = start + Math.floor((nowS - start) / period) * period;
      const last = s.last_epoch != null ? Number(s.last_epoch) : null;
      if (last != null && last >= lastFire) continue; // already backed up this period
      try { await runBookBackup(s.book_id, parseGroupList(s.groups)); }
      catch (e) { console.error(`scheduled backup failed for book ${s.book_id}:`, e); }
    }
  } catch (e) {
    console.error('scheduled backup sweep failed:', e);
  }
}
