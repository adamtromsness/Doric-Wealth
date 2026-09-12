import { type Filters, DEFAULT_FILTERS } from '../../components/txnFilters';
import type { Category, StagedTxn } from '../../types';

// Same day, or rolled to the next business day if it lands on a weekend.
export const businessDay = (d: string) => {
  const dt = new Date(d + 'T00:00:00');
  const wd = dt.getDay(); // 0 = Sun, 6 = Sat
  if (wd === 6) dt.setDate(dt.getDate() + 2);
  else if (wd === 0) dt.setDate(dt.getDate() + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

export type TagKind = 'vehicle' | 'property' | 'subscription' | 'tag';
export interface Tag { kind: TagKind; ref_id: number; name: string | null }
export const TAG_GLYPH: Record<TagKind, string> = { vehicle: '🚗', property: '🏠', subscription: '↻', tag: '🏷️' };
export const tagKey = (t: { kind: TagKind; ref_id: number }) => `${t.kind}:${t.ref_id}`;
export type Channel = 'in_store' | 'online' | 'phone' | 'mail' | 'check';
export const CHANNEL_LABEL: Record<Channel, string> = {
  in_store: 'In-store', online: 'Online', phone: 'Phone', mail: 'Mail', check: 'Check',
};
// Normalize a raw bank descriptor to a stable recurring-charge key. Mirror of
// recurringKey in server/src/routes/subscriptions.ts — keep the two in sync.
export const recurringKey = (merchant: string): string => {
  let s = (merchant ?? '').toLowerCase();
  s = s.replace(/[*x#]{2,}\s*\d+/g, ' ');
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ');
  s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');
  s = s.replace(/\b\d{3,}\b/g, ' ');
  s = s.replace(/^\s*(purchase|pos debit|pos|debit card|ach|sq|tst|sp|pp|paypal|recurring)\b/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s.replace(/\s+/g, ' ');
};

// Why an imported row was auto-skipped. Falls back to deriving the reason from
// duplicate_of/decision for rows staged before the skip_reason column existed.
export const stagedSkipReason = (s: StagedTxn): 'duplicate_in_file' | 'matches_existing' | null =>
  s.skip_reason ?? (s.duplicate_of != null ? 'matches_existing' : (s.decision === 'skip' ? 'duplicate_in_file' : null));

export interface Txn {
  id: number;
  account_id: number | null;
  category_id: number | null;
  transfer_account_id: number | null;
  txn_date: string;
  posted_date: string | null;
  amount: number;
  principal_amount: number | null;
  interest_category_id: number | null;
  direction: 'expense' | 'income' | 'transfer';
  merchant: string | null;
  description: string | null;
  purchaser: string | null;
  channel: Channel | null;
  source: string | null; // 'simplefin' = auto-imported, 'csv' = file import, null = manual
  category_name: string | null;
  account_name: string | null;
  transfer_account_name: string | null;
  has_receipt: boolean;
  tags: Tag[];
  splits: TxnSplit[];
  has_splits: boolean;
}
export interface TxnSplit {
  id?: number; amount: number; category_id: number | null;
  category_name?: string | null; notes?: string | null; tags: Tag[];
  is_principal?: boolean;
}
// A lookalike transaction (same normalized merchant) returned by /transactions/similar.
export interface SimilarTxn {
  id: number; merchant: string; txn_date: string | null; amount: number;
  direction: string; category_id: number | null; category_name: string | null;
}
// Groups sort income-first then by manual order; items by manual order — matching the Categories page.
export const byGroupOrder = (a: Category, b: Category) =>
  a.kind === b.kind ? a.sort_order - b.sort_order : a.kind === 'income' ? -1 : 1;
export const byItemOrder = (a: Category, b: Category) => a.sort_order - b.sort_order;
export interface Account { id: number; name: string; is_liability?: boolean; type?: string }
export interface Vehicle { id: number; name: string; disposed_at?: string | null }
export interface Property { id: number; name: string }
export interface Subscription { id: number; name: string; tier: string | null; status: string }
export interface UserTag { id: number; name: string; archived: boolean }

// Persist the filter selection across navigation and reloads.
export const FILTER_KEY = 'finance.txnFilters';
export function loadStored(): { filters: Filters; advancedOpen: boolean } | null {
  try { const s = localStorage.getItem(FILTER_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

// Deep-link from Accounts / Property / Vehicle pages: start a fresh filtered view.
export function deepLinkFilters(state: unknown): Filters | null {
  const st = state as { account_id?: number; property_id?: number; vehicle_id?: number } | null;
  if (st && (st.account_id || st.property_id || st.vehicle_id)) {
    return {
      ...DEFAULT_FILTERS,
      range: 'all', // a per-entity deep-link shows that entity's full history, not just recent
      account_id: st.account_id ? String(st.account_id) : '',
      property_id: st.property_id ? String(st.property_id) : '',
      vehicle_id: st.vehicle_id ? String(st.vehicle_id) : '',
    };
  }
  return null;
}

export const PAGE_SIZE = 50;

// Merchant standardization: collapse punctuation/spacing/casing to a key, then
// map to a canonical spelling — from a built-in list of common merchants, or the
// user's own past spellings (so the name they've used before wins).
export const merchantKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
export const MERCHANT_CANON: Record<string, string> = {
  walmart: 'Walmart', walmartsupercenter: 'Walmart', target: 'Target',
  costco: 'Costco', costcowholesale: 'Costco', samsclub: "Sam's Club",
  amazon: 'Amazon', amazoncom: 'Amazon', amzn: 'Amazon',
  kroger: 'Kroger', aldi: 'Aldi', publix: 'Publix', safeway: 'Safeway',
  wholefoods: 'Whole Foods', traderjoes: "Trader Joe's", traderjoe: "Trader Joe's",
  homedepot: 'Home Depot', lowes: "Lowe's", ikea: 'IKEA',
  cvs: 'CVS', walgreens: 'Walgreens', riteaid: 'Rite Aid',
  starbucks: 'Starbucks', mcdonalds: "McDonald's", chickfila: 'Chick-fil-A',
  chipotle: 'Chipotle', dunkin: 'Dunkin', dunkindonuts: 'Dunkin', subway: 'Subway',
  netflix: 'Netflix', spotify: 'Spotify', hulu: 'Hulu', disney: 'Disney+', disneyplus: 'Disney+',
  uber: 'Uber', ubereats: 'Uber Eats', lyft: 'Lyft', doordash: 'DoorDash', grubhub: 'Grubhub',
  shell: 'Shell', chevron: 'Chevron', exxon: 'Exxon', exxonmobil: 'Exxon', bp: 'BP',
  bestbuy: 'Best Buy', apple: 'Apple', applestore: 'Apple', google: 'Google',
  paypal: 'PayPal', venmo: 'Venmo',
};
// Returns the canonical spelling and whether it's a real change from the input.
export function standardizeMerchant(input: string, merchants: string[]): { value: string; changed: boolean } {
  const trimmed = input.trim();
  const key = merchantKey(trimmed);
  if (!key) return { value: trimmed, changed: false };
  const canon = MERCHANT_CANON[key] ?? merchants.find((m) => merchantKey(m) === key);
  if (canon && canon !== trimmed) return { value: canon, changed: true };
  return { value: trimmed, changed: false };
}

export interface TxnPage { pending: Txn[]; pendingTotal: number; posted: Txn[]; total: number }

// --- Tags multi-picker: chips + an "add" dropdown over all taggable entities ---
export type Lookups = { categories: Category[]; accounts: Account[]; vehicles: Vehicle[]; properties: Property[]; subscriptions: Subscription[]; tags: UserTag[] };

export function nameFor(l: Lookups, kind: TagKind, ref_id: number): string | null {
  const list = kind === 'vehicle' ? l.vehicles : kind === 'property' ? l.properties : kind === 'tag' ? l.tags : l.subscriptions;
  return (list as { id: number; name: string }[]).find((x) => x.id === ref_id)?.name ?? null;
}

export interface LineForm { category_id: string; tags: Tag[]; amount: string; is_principal?: boolean }

export const lineFromSplit = (s: TxnSplit): LineForm => ({ category_id: s.category_id?.toString() ?? '', tags: s.tags ?? [], amount: s.amount.toString(), is_principal: !!s.is_principal });

// Controlled top-level taxonomy for receipt items. Keep in sync with the server copy in
// server/src/routes/transactions.ts (ITEM_CATEGORIES).
export const ITEM_CATEGORIES = [
  'Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Pantry & Dry Goods', 'Snacks',
  'Beverages', 'Frozen', 'Candy & Sweets', 'Book & Cleaning', 'Personal Care & Health',
  'Baby & Kids', 'Pet', 'Alcohol', 'Other',
] as const;
export interface Item { name: string; brand: string; category: string; size: string; unit: string; product_category: string; quantity: string; unit_price: string; total_price: string }
export const blankItem = (): Item => ({ name: '', brand: '', category: '', size: '', unit: '', product_category: '', quantity: '1', unit_price: '', total_price: '' });
export interface ReceiptState {
  merchant: string; purchased_at: string; subtotal: string; tax: string; total: string; notes: string;
  items: Item[]; image: string | null; image_mime: string | null; original_name: string | null; has_image: boolean;
}
export const emptyReceipt = (): ReceiptState => ({ merchant: '', purchased_at: '', subtotal: '', tax: '', total: '', notes: '', items: [blankItem()], image: null, image_mime: null, original_name: null, has_image: false });
