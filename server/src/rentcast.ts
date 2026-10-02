// RentCast (rentcast.io) property value estimates (AVM, from comparable sales).
// The API key belongs to a book: an owner/admin adds it under Integrations → RentCast
// (stored encrypted, books.rentcast_api_key). The server's RENTCAST_API_KEY, if set,
// is the fallback for books without their own key.
import { config } from './config.js';
import { one } from './db.js';
import { HttpError } from './http.js';
import { decodeKeyAtRest } from './secrets.js';

export type KeySource = 'book' | 'server' | null;

// The key to use for a book, and where it came from.
export async function resolveRentcastKey(bookId: number): Promise<{ key: string | null; source: KeySource }> {
  const row = await one<{ rentcast_api_key: string | null }>(`SELECT rentcast_api_key FROM books WHERE id = $1`, [bookId]);
  const own = decodeKeyAtRest(row?.rentcast_api_key, 'RentCast API key');
  if (own) return { key: own, source: 'book' };
  if (config.rentcastApiKey) return { key: config.rentcastApiKey, source: 'server' };
  return { key: null, source: null };
}

// Join "City, ST ZIP" onto the street line for geocoding / display.
export function fullAddress(b: any): string | null {
  const parts = [b.address, [b.city, b.state].filter(Boolean).join(', '), b.zip]
    .map((p: any) => (p ? String(p).trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(' ').replace(/\s+,/g, ',') : null;
}

const numOrNull = (n: any) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

// Map our property types to RentCast's expected propertyType values (others omitted).
const RENTCAST_TYPE: Record<string, string> = {
  single_family: 'Single Family', condo: 'Condo', townhouse: 'Townhouse',
  multi_family: 'Multi-Family', land: 'Land',
};

export interface ValueEstimate {
  value: number; low: number | null; high: number | null; rationale: string; source: 'rentcast';
}

// Fetch a value estimate. Failures become HttpErrors with fixed, user-facing messages;
// RentCast's own response text is logged server-side only.
export async function rentcastValue(apiKey: string, address: string, sqft: number | null, type: string | null): Promise<ValueEstimate> {
  const params = new URLSearchParams({ address });
  if (sqft) params.set('squareFootage', String(sqft));
  if (type && RENTCAST_TYPE[type]) params.set('propertyType', RENTCAST_TYPE[type]);

  let r: globalThis.Response;
  try {
    r = await fetch(`https://api.rentcast.io/v1/avm/value?${params.toString()}`, {
      headers: { 'X-Api-Key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach RentCast. Try again later.');
  }
  if (!r.ok) {
    let msg = '';
    try { msg = ((await r.json()) as any)?.message || ''; } catch { /* ignore */ }
    console.error(`RentCast AVM error (${r.status})${msg ? `: ${msg}` : ''}`);
    if (r.status === 401 || r.status === 403) {
      throw new HttpError(502, 'RentCast rejected the API key. Check it under Integrations → RentCast, and that your RentCast plan is active.');
    }
    if (r.status === 404) throw new HttpError(404, 'RentCast has no value estimate for that address.');
    if (r.status === 429) throw new HttpError(429, "RentCast's request limit for your plan has been reached. Try again next month, or upgrade your RentCast plan.");
    throw new HttpError(502, 'Could not retrieve a value estimate from RentCast right now. Try again later.');
  }

  const d = (await r.json()) as any;
  const value = numOrNull(d.price);
  if (value == null) throw new HttpError(502, 'RentCast returned no value for that address.');
  return {
    value,
    low: numOrNull(d.priceRangeLow),
    high: numOrNull(d.priceRangeHigh),
    rationale: 'RentCast AVM estimate from comparable sales.',
    source: 'rentcast',
  };
}
