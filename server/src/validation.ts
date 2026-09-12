// Shared, dependency-free request validation. Centralizes the checks that were
// previously scattered across routes (or left to raw SQL errors) so malformed
// payloads get a clean 400 and cross-book references get a clean 404 before
// any insert/update. A local module (vs. a library like zod) matches this
// codebase's no-dependency style for its CSV parser, auth, etc.
import { HttpError } from './http.js';
import { one } from './db.js';

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// ─────────────────────────── value validators (no DB) ───────────────────────────
// Each throws HttpError(400, …) on invalid input. `field` names it in the message.

export function requiredString(value: unknown, field: string, opts: { max?: number; trim?: boolean } = {}): string {
  if (isBlank(value)) throw new HttpError(400, `${field} is required.`);
  let s = String(value);
  if (opts.trim !== false) s = s.trim();
  if (opts.max != null && s.length > opts.max) throw new HttpError(400, `${field} must be at most ${opts.max} characters.`);
  return s;
}

export function optionalString(value: unknown, field: string, opts: { max?: number; trim?: boolean } = {}): string | null {
  if (isBlank(value)) return null;
  return requiredString(value, field, opts);
}

// A finite numeric money value (accepts a number or a numeric string). Negatives
// and zero are allowed by default (balances, adjustments); pass {min}/{max} to bound.
export function money(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (isBlank(value)) throw new HttpError(400, `${field} is required.`);
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
  // Money is stored as NUMERIC(16,2). Reject sub-cent precision and snap to exact
  // cents so the value that passes validation is EXACTLY what Postgres stores — if we
  // let the DB round on write, JS-side checks (e.g. assertSplitTotal) can pass on
  // unrounded inputs while the rounded splits no longer sum to the parent amount.
  // The tolerance absorbs float-representation noise on a clean 2-decimal value
  // (e.g. 12345.67) without admitting a genuine third decimal (off by ≥ 0.1 in cents).
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-3) {
    throw new HttpError(400, `${field} must be in whole cents (at most 2 decimal places).`);
  }
  const snapped = cents / 100;
  if (opts.min != null && snapped < opts.min) throw new HttpError(400, `${field} must be at least ${opts.min}.`);
  if (opts.max != null && snapped > opts.max) throw new HttpError(400, `${field} must be at most ${opts.max}.`);
  return snapped;
}

export function optionalMoney(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number | null {
  if (isBlank(value)) return null;
  return money(value, field, opts);
}

// A finite numeric value with NO cent-scale constraint. For quantities and rates that
// are legitimately more precise than money — utility usage (NUMERIC(16,3)), interest
// rates (NUMERIC(6,3)), lot size in acres, receipt item quantity/unit price. Do NOT
// validate these with money(): it rejects > 2 decimal places.
export function numberValue(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (isBlank(value)) throw new HttpError(400, `${field} is required.`);
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
  if (opts.min != null && n < opts.min) throw new HttpError(400, `${field} must be at least ${opts.min}.`);
  if (opts.max != null && n > opts.max) throw new HttpError(400, `${field} must be at most ${opts.max}.`);
  return n;
}

export function optionalNumber(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number | null {
  if (isBlank(value)) return null;
  return numberValue(value, field, opts);
}

// A strict YYYY-MM-DD calendar date — what the SPA's date inputs send.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function dateOnly(value: unknown, field: string): string {
  if (isBlank(value)) throw new HttpError(400, `${field} is required.`);
  const s = String(value).trim();
  if (!DATE_RE.test(s)) throw new HttpError(400, `${field} must be a date (YYYY-MM-DD).`);
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new HttpError(400, `${field} is not a valid date.`);
  }
  return s;
}

export function optionalDateOnly(value: unknown, field: string): string | null {
  if (isBlank(value)) return null;
  return dateOnly(value, field);
}

export function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const s = value == null ? '' : String(value);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return s as T;
}

export function optionalEnumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (isBlank(value)) return null;
  return enumValue(value, field, allowed);
}

// A positive integer id (accepts a number or numeric string).
export function integerId(value: unknown, field: string): number {
  if (isBlank(value)) throw new HttpError(400, `${field} is required.`);
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a positive integer id.`);
  return n;
}

export function optionalIntegerId(value: unknown, field: string): number | null {
  if (isBlank(value)) return null;
  return integerId(value, field);
}

export function booleanValue(value: unknown, field: string, opts: { default?: boolean } = {}): boolean {
  if (value === undefined || value === null) {
    if (opts.default !== undefined) return opts.default;
    throw new HttpError(400, `${field} is required.`);
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpError(400, `${field} must be true or false.`);
}

export function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  return booleanValue(value, field);
}

// ─────────────────────── enum sets (mirror the DB CHECK constraints) ───────────────────────
// Canonical account types — kept in sync with web/src/api.ts ACCOUNT_TYPES and the
// accounts_type_check DB constraint (migrations/121_account_type_529.sql).
export const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'hsa', 'fsa', 'money_market', 'cd', 'investment', 'retirement', '529', 'brokerage', 'crypto', 'loan', 'mortgage', 'cash', 'asset', 'other'] as const;
// How a vehicle left ownership when retired (preserves history; not deleted).
export const VEHICLE_DISPOSAL_TYPES = ['sold', 'traded_in', 'scrapped', 'totaled', 'gifted', 'other'] as const;
// How a property left ownership when retired (preserves history; not deleted).
export const PROPERTY_DISPOSAL_TYPES = ['sold', 'transferred', 'foreclosed', 'gifted', 'other'] as const;
export const TXN_DIRECTIONS = ['expense', 'income', 'transfer'] as const;
export const CHANNELS = ['in_store', 'online', 'phone', 'mail', 'check'] as const;
export const BUDGET_PERIODS = ['weekly', 'monthly', 'yearly', 'custom'] as const;
export const ROLLOVER_MODES = ['reset', 'carryover', 'accrue'] as const;
export const TAG_KINDS = ['vehicle', 'property', 'tag', 'subscription'] as const;
export const UTILITY_TYPES = ['electricity', 'gas', 'water', 'sewer', 'trash', 'internet', 'phone', 'other'] as const;
export const UTILITY_BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'] as const;
export const IMPORT_DECISIONS = ['import', 'skip'] as const;
export const CATEGORY_KINDS = ['expense', 'income'] as const;
export const PROPERTY_TYPES = ['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'commercial', 'vacation', 'rental', 'other'] as const;
export const ASSET_TYPES = ['property', 'rv', 'airplane', 'boat', 'equipment', 'collectible', 'other'] as const;
export const LIABILITY_TYPES = ['mortgage', 'auto_loan', 'student_loan', 'personal_loan', 'credit_card', 'medical', 'other'] as const;
export const GOAL_TYPES = ['savings', 'reduce_spending', 'debt_payoff'] as const;
export const GOAL_STATUSES = ['active', 'archived'] as const;
export const GOAL_PERIODS = ['weekly', 'monthly', 'yearly'] as const;
export const SUBSCRIPTION_STATUSES = ['active', 'paused', 'canceled'] as const;
export const SUBSCRIPTION_BILLING_CYCLES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;

// ─────────────────────────── ownership validators (DB) ───────────────────────────
// Cross-book references resolve to a 404 ("not found in this book"),
// matching the existing not-found convention. Queries run on the request-bound,
// RLS-scoped connection (and also filter book_id explicitly, belt-and-suspenders).

// Fixed allowlist of tenant tables — table names are never taken from user input.
const OWNED_TABLES = {
  account: 'accounts',
  category: 'categories',
  budget: 'budgets',
  vehicle: 'vehicles',
  property: 'properties',
  tag: 'tags',
  utility_account: 'utility_accounts',
  liability: 'liabilities',
  asset: 'assets',
  transaction: 'transactions',
} as const;
export type OwnedKind = keyof typeof OWNED_TABLES;
const OWNED_LABEL: Record<OwnedKind, string> = {
  account: 'Account', category: 'Category', budget: 'Budget', vehicle: 'Vehicle',
  property: 'Property', tag: 'Tag', utility_account: 'Utility account',
  liability: 'Liability', asset: 'Asset', transaction: 'Transaction',
};

// Assert that `id` exists in the active book; throw 404 otherwise. Returns the id.
export async function assertOwned(kind: OwnedKind, id: number, bookId: number): Promise<number> {
  const found = await one(`SELECT 1 FROM ${OWNED_TABLES[kind]} WHERE id = $1 AND book_id = $2`, [id, bookId]);
  if (!found) throw new HttpError(404, `${OWNED_LABEL[kind]} not found in this book.`);
  return id;
}

// Validate an OPTIONAL reference field: blank → null; otherwise a positive id that
// must belong to the active book.
export async function ownedRef(kind: OwnedKind, value: unknown, bookId: number, field: string): Promise<number | null> {
  if (isBlank(value)) return null;
  const id = integerId(value, field);
  await assertOwned(kind, id, bookId);
  return id;
}

// A line tag's target (vehicle/property/tag) must belong to the book.
const TAG_TARGET_TABLE: Record<(typeof TAG_KINDS)[number], string> = { vehicle: 'vehicles', property: 'properties', tag: 'tags', subscription: 'subscriptions' };
export async function assertTagRefOwned(kind: string, refId: number, bookId: number): Promise<void> {
  const k = enumValue(kind, 'tag kind', TAG_KINDS);
  const found = await one(`SELECT 1 FROM ${TAG_TARGET_TABLE[k]} WHERE id = $1 AND book_id = $2`, [refId, bookId]);
  if (!found) throw new HttpError(404, `Tagged ${k} not found in this book.`);
}

// Split amounts must add up to the transaction amount (cent tolerance).
export function assertSplitTotal(splitAmounts: number[], txnAmount: number): void {
  const sum = splitAmounts.reduce((acc, n) => acc + n, 0);
  // Half-cent tolerance: only absorbs float noise, not a genuine 1¢ mismatch (which
  // would leave the splits disagreeing with the parent amount in balance/ledger math).
  if (!Number.isFinite(sum) || Math.abs(sum - Number(txnAmount)) > 0.005) {
    throw new HttpError(400, `Split amounts (${sum.toFixed(2)}) must add up to the transaction amount (${Number(txnAmount).toFixed(2)}).`);
  }
}

// Round a money value to whole cents. Money is stored as NUMERIC(16,2) but crosses
// the app boundary as a JS float (see db.ts), so any value DERIVED by JS arithmetic
// (a difference, a sum the DB didn't compute) can carry sub-cent float noise like
// 1234.5600000000001. Apply this before returning such values so the client never
// sees or compares the noise.
export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Coerce free-text to a trimmed string capped at `max` chars, or null if blank.
// Used to bound fields that originate from AI extraction (receipt/invoice scans) or
// bulk imports, where the value is untrusted and unbounded; clipping is friendlier
// than a hard 400 for what is fundamentally display text the user can edit.
export function clampText(value: unknown, max = 500): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
