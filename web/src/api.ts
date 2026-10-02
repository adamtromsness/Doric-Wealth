const BASE = '/api';
// Optional shared secret (set VITE_API_TOKEN at build time to match the server's API_TOKEN).
const API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN ?? '';

// The AuthProvider registers a handler so a 401 anywhere drops us back to login.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn; }

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...opts,
    credentials: 'include', // send the session cookie
    headers: {
      'content-type': 'application/json',
      ...(API_TOKEN ? { 'x-api-token': API_TOKEN } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) => req<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(p: string, body?: unknown) => req<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(p: string, body?: unknown) => req<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: (p: string) => req<void>(p, { method: 'DELETE' }),
};

// POST and read a newline-delimited-JSON (NDJSON) stream, invoking `onEvent` for each
// parsed line as it arrives. Used for long operations that report live progress.
export async function apiStream(path: string, body: unknown, onEvent: (ev: any) => void): Promise<void> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(API_TOKEN ? { 'x-api-token': API_TOKEN } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) {
    if (res.status === 401) onUnauthorized?.();
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = () => {
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { onEvent(JSON.parse(line)); } catch { /* ignore partial/garbage */ } }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    flush();
  }
  buf += decoder.decode();
  if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* ignore */ } }
}

// Fetch a path and save the response as a file (honoring the server's
// Content-Disposition filename when present). Used for data backups/exports.
// Fetch a path and return its body as a Blob (no browser "Save as"). Used to write a
// file into a directory the user granted via the File System Access API.
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(BASE + path, { credentials: 'include', headers: { ...(API_TOKEN ? { 'x-api-token': API_TOKEN } : {}) } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(BASE + path, { credentials: 'include', headers: { ...(API_TOKEN ? { 'x-api-token': API_TOKEN } : {}) } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function money(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = n < 0 ? '−$' : opts.sign ? '+$' : '$';
  return prefix + v;
}

// Parse a 'YYYY-MM-DD' (or ISO) string as LOCAL midnight. Bare date strings are
// otherwise parsed as UTC by JS, which shifts the displayed day for users west
// of UTC. Use this everywhere a calendar date is shown or compared.
export function parseLocalDate(d: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
}

// True only for a well-formed http(s) URL. Shared by the account login pill/button
// so "open login" never tries to open junk.
export const isHttpUrl = (u: string | null | undefined): boolean => {
  const s = (u ?? '').trim();
  if (!s) return false;
  try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; }
};

export function shortDate(d: string | null | undefined): string {
  if (!d) return '—';
  return parseLocalDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// Age in whole years on `today` (YYYY-MM-DD) for a YYYY-MM-DD date of birth, or null
// when the date is missing or invalid. Counts a birthday only once it has passed.
export function ageOn(dob: string | null | undefined, today: string = todayStr()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob ?? '');
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!m || !t) return null;
  const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])];
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 0 ? age : null;
}

// Oldest age a person can be entered with (matches the server's rule).
export const MAX_AGE_YEARS = 120;

// A problem with a date of birth, or null when it's fine (or blank).
export function dobProblem(dob: string | null | undefined, today: string = todayStr()): string | null {
  if (!dob) return null;
  if (dob > today) return "Date of birth can't be in the future.";
  const age = ageOn(dob, today);
  if (age == null) return 'Enter a valid date of birth.';
  if (age > MAX_AGE_YEARS) return `Date of birth can't be more than ${MAX_AGE_YEARS} years ago.`;
  return null;
}

// The earliest date of birth allowed today (someone exactly MAX_AGE_YEARS old), for a
// date input's `min`.
export function earliestDob(today: string = todayStr()): string {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y - MAX_AGE_YEARS - 1, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

// Normalize a user-entered site to an absolute, openable URL (default to https).
export const normalizeUrl = (u: string | null | undefined): string | null => {
  const s = (u ?? '').trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

// Standardize a US phone number typed in any format to "(XXX) XXX-XXXX" (or
// "+1 (XXX) XXX-XXXX" when it's 11 digits starting with 1). Preserves an extension
// ("x123" / "ext 123") and leaves anything that isn't a recognizable US number
// (other lengths, international, partial) untouched.
export const formatPhone = (raw: string | null | undefined): string => {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const extMatch = s.match(/(?:\s*(?:x|ext\.?|extension)\s*(\d+))\s*$/i);
  const ext = extMatch ? extMatch[1] : '';
  const main = (ext ? s.slice(0, extMatch!.index) : s).replace(/\D/g, '');
  let formatted: string;
  if (main.length === 10) formatted = `(${main.slice(0, 3)}) ${main.slice(3, 6)}-${main.slice(6)}`;
  else if (main.length === 11 && main[0] === '1') formatted = `+1 (${main.slice(1, 4)}) ${main.slice(4, 7)}-${main.slice(7)}`;
  else return s; // unrecognized shape — leave exactly as typed
  return ext ? `${formatted} x${ext}` : formatted;
};

// Whether a user-entered value resolves to a real, openable http(s) URL (requires a
// hostname with a dot, so "abc" or empty input is rejected).
export const isOpenableUrl = (raw: string | null | undefined): boolean => {
  const u = normalizeUrl(raw);
  if (!u) return false;
  try { const url = new URL(u); return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.'); }
  catch { return false; }
};

// Canonical account types (value → human label). This is the single source of
// truth shared with server validation (validation.ts ACCOUNT_TYPES) and the
// accounts_type_check DB constraint (migrations/121_account_type_529.sql) —
// keep all three in sync. Retirement subtypes (IRA/401k) are represented by the
// broad 'retirement' type; 529 college-savings plans have their own type; loan
// subtypes live on the liabilities table.
// 'other' is the catch-all for anything not listed.
export const ACCOUNT_TYPES: [string, string][] = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['credit_card', 'Credit Card'],
  ['hsa', 'HSA'],
  ['fsa', 'FSA'],
  ['money_market', 'Money Market'],
  ['cd', 'CD'],
  ['investment', 'Investment'],
  ['retirement', 'Retirement (401k/IRA)'],
  ['529', '529 College Savings'],
  ['brokerage', 'Brokerage'],
  ['crypto', 'Crypto'],
  ['loan', 'Loan'],
  ['mortgage', 'Mortgage'],
  ['cash', 'Cash'],
  ['asset', 'Asset'],
  ['other', 'Other'],
];
export const accountTypeLabel = (t: string) => ACCOUNT_TYPES.find(([v]) => v === t)?.[1] ?? t;
// Types that default to counting as a liability (subtract from net worth).
export const LIABILITY_ACCOUNT_TYPES = ['credit_card', 'loan', 'mortgage'];

export const PROPERTY_TYPES: [string, string][] = [
  ['single_family', 'Single-Family Home'],
  ['condo', 'Condo'],
  ['townhouse', 'Townhouse'],
  ['multi_family', 'Multi-Family'],
  ['rental', 'Rental'],
  ['vacation', 'Vacation Home'],
  ['land', 'Land'],
  ['commercial', 'Commercial'],
  ['other', 'Other'],
];
export const propertyTypeLabel = (t: string) => PROPERTY_TYPES.find(([v]) => v === t)?.[1] ?? t;

// How a vehicle left ownership when retired (mirrors server VEHICLE_DISPOSAL_TYPES).
export const VEHICLE_DISPOSAL_TYPES: [string, string][] = [
  ['sold', 'Sold'],
  ['traded_in', 'Traded In'],
  ['scrapped', 'Scrapped'],
  ['totaled', 'Totaled'],
  ['gifted', 'Gifted'],
  ['other', 'Other'],
];
export const disposalTypeLabel = (t: string | null | undefined) =>
  (t ? VEHICLE_DISPOSAL_TYPES.find(([v]) => v === t)?.[1] ?? t : 'Disposed');

// How a property left ownership when retired (mirrors server PROPERTY_DISPOSAL_TYPES).
export const PROPERTY_DISPOSAL_TYPES: [string, string][] = [
  ['sold', 'Sold'],
  ['transferred', 'Transferred'],
  ['foreclosed', 'Foreclosed'],
  ['gifted', 'Gifted'],
  ['other', 'Other'],
];
export const propertyDisposalTypeLabel = (t: string | null | undefined) =>
  (t ? PROPERTY_DISPOSAL_TYPES.find(([v]) => v === t)?.[1] ?? t : 'Disposed');
