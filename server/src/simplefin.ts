// Minimal SimpleFIN Bridge client (no dependencies). Two steps:
//   1. claimAccessUrl(setupToken): base64-decode the one-time setup token into a
//      claim URL, POST to it, and receive a long-lived access URL that embeds
//      read-only basic-auth credentials.
//   2. fetchAccounts(accessUrl): GET <accessUrl>/accounts → accounts + transactions.
// SimpleFIN is read-only by design. See https://www.simplefin.org/protocol.html
import { HttpError } from './http.js';

const TIMEOUT_MS = 20_000;

// The setup/claim URL host comes from a user-supplied setup token, so validate it
// before we make a server-side request to it: https only, and never a private or
// loopback address (SSRF guard).
function assertSafeUrl(raw: string, label: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, `That SimpleFIN ${label} is not a valid URL.`); }
  if (u.protocol !== 'https:') throw new HttpError(400, `SimpleFIN ${label} must use https.`);
  const h = u.hostname;
  const privateHost =
    h === 'localhost' || h === '::1' || h === '0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (privateHost) throw new HttpError(400, 'Refusing to contact a private network address.');
  return u;
}

// Split basic-auth creds out of a URL into an Authorization header — Node's fetch
// (undici) does not send userinfo embedded in the URL.
function withBasicAuth(u: URL): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (u.username || u.password) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    headers.authorization = 'Basic ' + Buffer.from(creds).toString('base64');
    u.username = '';
    u.password = '';
  }
  return { url: u.toString(), headers };
}

// Claim a one-time setup token, returning the durable access URL. Idempotency is
// the caller's concern — a setup token can be claimed only once by SimpleFIN.
export async function claimAccessUrl(setupToken: string): Promise<string> {
  let claimUrl: string;
  try { claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8'); }
  catch { throw new HttpError(400, 'That SimpleFIN setup token could not be read.'); }
  const u = assertSafeUrl(claimUrl, 'setup token');

  let res: Response;
  try { res = await fetch(u.toString(), { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new HttpError(502, 'Could not reach SimpleFIN to set up the connection.'); }
  if (!res.ok) throw new HttpError(502, `SimpleFIN setup failed (${res.status}). The token may already be used or expired.`);

  const accessUrl = (await res.text()).trim();
  assertSafeUrl(accessUrl, 'access URL'); // also rejects a hostile claim response
  return accessUrl;
}

export interface SfTxn {
  id: string;
  posted: number;          // unix seconds (posted time)
  amount: string;          // signed decimal string; negative = money out
  description?: string;
  payee?: string;
  memo?: string;
  transacted_at?: number;
  pending?: boolean;
}
export interface SfHolding {
  id: string;
  symbol?: string;
  description?: string;
  shares?: string;        // decimal strings, like amounts
  market_value?: string;
  cost_basis?: string;
  purchase_price?: string;
  currency?: string;
  created?: number;
}
export interface SfAccount {
  org: { name?: string; domain?: string };
  id: string;
  name: string;
  currency: string;
  balance: string;
  'balance-date': number;
  'available-balance'?: string;
  transactions: SfTxn[];
  holdings?: SfHolding[];  // investment positions, when the institution provides them
}

// Fetch accounts (and their transactions). `startDate` (unix seconds) limits the
// transaction window on re-syncs; posted-only by default.
export async function fetchAccounts(
  accessUrl: string,
  opts: { startDate?: number; endDate?: number; pending?: boolean } = {}
): Promise<{ accounts: SfAccount[]; errors: string[] }> {
  const base = assertSafeUrl(accessUrl, 'access URL');
  const u = new URL(base.toString().replace(/\/$/, '') + '/accounts');
  if (opts.startDate) u.searchParams.set('start-date', String(Math.floor(opts.startDate)));
  if (opts.endDate) u.searchParams.set('end-date', String(Math.floor(opts.endDate)));
  u.searchParams.set('pending', opts.pending ? '1' : '0');

  const { url, headers } = withBasicAuth(u);
  let res: Response;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new HttpError(502, 'Could not reach SimpleFIN.'); }
  if (!res.ok) throw new HttpError(502, `SimpleFIN request failed (${res.status}).`);

  const data = (await res.json()) as { accounts?: SfAccount[]; errors?: string[] };
  return { accounts: data.accounts ?? [], errors: data.errors ?? [] };
}
