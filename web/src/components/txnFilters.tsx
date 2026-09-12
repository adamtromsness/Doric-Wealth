import { useMemo } from 'react';
import { type RangeKey, RANGES, rangeDates } from '../dateRange';
import { Field, AmountInput } from './ui';
import type { Category } from '../types';

// Shared transaction filter/search bar, used by the Transactions page and the
// account-detail Transactions tab. The account-detail view passes showAccount=false
// since it's already scoped to one account.

export type AmountOp = '' | 'gt' | 'lt' | 'between' | 'eq';
export const AMOUNT_OPS: [AmountOp, string][] = [
  ['', 'Any'], ['gt', 'Greater Than'], ['lt', 'Less Than'], ['between', 'Between'], ['eq', 'Exact'],
];
export const CHANNEL_OPTIONS: [string, string][] = [
  ['in_store', 'In Store'], ['online', 'Online'], ['phone', 'Phone'], ['mail', 'Mail'], ['check', 'Check'],
];

export interface Filters {
  range: RangeKey; from: string; to: string;
  account_id: string; category_id: string; vehicle_id: string; property_id: string; tag_id: string; channel: string;
  q: string; amount_op: AmountOp; amount: string; amount_max: string;
  uncategorized: string; // '1' = show only transactions that still need a category
  transfers: string; // '1' = show only transfers (account-to-account movements)
}
export const DEFAULT_FILTERS: Filters = {
  // The fresh browse view defaults to the last 90 days (faster at scale; "All Time"
  // is one chip-click away). Intent-carrying deep-links (uncategorized / per-entity)
  // override this back to 'all' so they still span the full history.
  range: 'last_90', from: '', to: '',
  account_id: '', category_id: '', vehicle_id: '', property_id: '', tag_id: '', channel: '',
  q: '', amount_op: '', amount: '', amount_max: '',
  uncategorized: '', transfers: '',
};

// Consistent pill button sizing for the filter toggles.
export const chip = { padding: '5px 12px', fontSize: 13 } as const;

// Build the query params from the active filters (each key set only when present).
export function buildTxnParams(filters: Filters): URLSearchParams {
  const { from, to } = rangeDates(filters.range, filters.from, filters.to);
  const p = new URLSearchParams();
  const set = (k: string, v: string) => { if (v) p.set(k, v); };
  set('from', from); set('to', to);
  set('account_id', filters.account_id); set('category_id', filters.category_id);
  set('vehicle_id', filters.vehicle_id); set('property_id', filters.property_id);
  set('tag_id', filters.tag_id);
  set('channel', filters.channel); set('q', filters.q);
  set('uncategorized', filters.uncategorized);
  set('transfers', filters.transfers);
  if (filters.amount_op && filters.amount) {
    set('amount_op', filters.amount_op); set('amount', filters.amount);
    if (filters.amount_op === 'between') set('amount_max', filters.amount_max);
  }
  return p;
}

// Count of active "advanced" filters (shown on the toggle even when collapsed).
export function advancedCount(f: Filters): number {
  return [f.category_id, f.vehicle_id, f.property_id, f.tag_id, f.channel, f.uncategorized, f.transfers].filter(Boolean).length
    + (f.amount_op && f.amount ? 1 : 0);
}

// Groups sort income-first then by manual order; items by manual order.
const byGroupOrder = (a: Category, b: Category) =>
  a.kind === b.kind ? a.sort_order - b.sort_order : a.kind === 'income' ? -1 : 1;
const byItemOrder = (a: Category, b: Category) => a.sort_order - b.sort_order;
// Flattened leaf categories (group order), used for the category filter pills.
export function leafCategoryOptions(categories: Category[]): { value: string; name: string }[] {
  const out: { value: string; name: string }[] = [];
  for (const g of categories.filter((c) => c.parent_id === null && c.has_children).sort(byGroupOrder)) {
    for (const it of categories.filter((c) => c.parent_id === g.id).sort(byItemOrder)) out.push({ value: String(it.id), name: it.name });
  }
  return out;
}

// Multi-select pill row (comma-joined value), shared by the advanced filters.
export function PillMulti({ label, options, value, onChange }: {
  label: string; options: { value: string; name: string }[]; value: string; onChange: (v: string) => void;
}) {
  const sel = value ? value.split(',') : [];
  const toggle = (v: string) => {
    const s = new Set(sel);
    s.has(v) ? s.delete(v) : s.add(v);
    onChange([...s].join(','));
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className={sel.length === 0 ? '' : 'ghost'} style={chip} onClick={() => onChange('')}>All</button>
        {options.map((o) => (
          <button key={o.value} className={sel.includes(o.value) ? '' : 'ghost'} style={chip} onClick={() => toggle(o.value)}>{o.name}</button>
        ))}
      </div>
    </div>
  );
}

export interface FilterLookups {
  accounts: { id: number; name: string }[];
  categories: Category[];
  vehicles: { id: number; name: string }[];
  properties: { id: number; name: string }[];
  tags: { id: number; name: string }[];
}

export function TxnFilterBar({ filters, setFilters, advancedOpen, setAdvancedOpen, lookups, showAccount = true }: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  lookups: FilterLookups;
  showAccount?: boolean;
}) {
  const { accounts, categories, vehicles, properties, tags } = lookups;
  const leafCategories = useMemo(() => leafCategoryOptions(categories), [categories]);
  const selectedAccountIds = filters.account_id ? filters.account_id.split(',').map(Number) : [];
  const toggleAccount = (id: number) => {
    const s = new Set(selectedAccountIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setFilters({ ...filters, account_id: [...s].join(',') });
  };
  const advCount = advancedCount(filters);
  // Total non-search filters in effect (account + non-default range + advanced), shown on
  // the Filters toggle so the user knows filters are applied even while it's collapsed.
  const activeCount = advCount
    + (showAccount && filters.account_id ? 1 : 0)
    + (filters.range !== DEFAULT_FILTERS.range ? 1 : 0);

  // Human-readable summary of the active (non-search) filters. Shown under the search bar
  // even when the Filters panel is collapsed; each chip removes just that one filter.
  const namesFrom = (list: { id: number; name: string }[], csv: string) =>
    csv.split(',').map((s) => list.find((x) => x.id === Number(s))?.name ?? `#${s}`).join(', ');
  const activeChips: { key: string; label: string; patch: Partial<Filters> }[] = [];
  if (filters.range !== DEFAULT_FILTERS.range) {
    const rl = filters.range === 'custom'
      ? `${filters.from || '…'} – ${filters.to || '…'}`
      : (RANGES.find(([k]) => k === filters.range)?.[1] ?? filters.range);
    activeChips.push({ key: 'range', label: `Date: ${rl}`, patch: { range: DEFAULT_FILTERS.range, from: '', to: '' } });
  }
  if (showAccount && filters.account_id) activeChips.push({ key: 'account', label: `Account: ${namesFrom(accounts, filters.account_id)}`, patch: { account_id: '' } });
  if (filters.uncategorized) activeChips.push({ key: 'uncat', label: 'Uncategorized only', patch: { uncategorized: '' } });
  if (filters.transfers) activeChips.push({ key: 'transfers', label: 'Transfers only', patch: { transfers: '' } });
  if (filters.amount_op && filters.amount) {
    const al = filters.amount_op === 'between'
      ? `Amount: $${filters.amount}–$${filters.amount_max || '…'}`
      : `Amount ${({ gt: '>', lt: '<', eq: '=' } as Record<string, string>)[filters.amount_op] ?? ''} $${filters.amount}`;
    activeChips.push({ key: 'amount', label: al, patch: { amount_op: '', amount: '', amount_max: '' } });
  }
  if (filters.channel) activeChips.push({ key: 'channel', label: `Channel: ${filters.channel.split(',').map((v) => CHANNEL_OPTIONS.find(([cv]) => cv === v)?.[1] ?? v).join(', ')}`, patch: { channel: '' } });
  if (filters.category_id) activeChips.push({ key: 'category', label: `Category: ${filters.category_id.split(',').map((id) => leafCategories.find((c) => c.value === id)?.name ?? `#${id}`).join(', ')}`, patch: { category_id: '' } });
  if (filters.vehicle_id) activeChips.push({ key: 'vehicle', label: `Vehicle: ${namesFrom(vehicles, filters.vehicle_id)}`, patch: { vehicle_id: '' } });
  if (filters.property_id) activeChips.push({ key: 'property', label: `Property: ${namesFrom(properties, filters.property_id)}`, patch: { property_id: '' } });
  if (filters.tag_id) activeChips.push({ key: 'tag', label: `Tag: ${namesFrom(tags, filters.tag_id)}`, patch: { tag_id: '' } });

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h2 className="section" style={{ margin: '0 0 12px' }}>Search</h2>
      {/* Only the search box is exposed by default; everything else lives behind Filters. */}
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search merchant or notes — e.g. Costco"
            style={{ width: '100%', paddingRight: filters.q ? 30 : undefined }} />
          {filters.q && (
            <button type="button" title="Clear search" aria-label="Clear search"
              onClick={() => setFilters({ ...filters, q: '' })}
              style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18, lineHeight: 1, padding: '2px 8px' }}>
              ×
            </button>
          )}
        </div>
        <button className="ghost" style={chip} onClick={() => setAdvancedOpen(!advancedOpen)}>
          {advancedOpen ? '▾' : '▸'} Filters{!advancedOpen && activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
        {/* Always present; only goes dark/active when the search field has text. */}
        <button className={filters.q ? '' : 'ghost'} style={chip} disabled={!filters.q} onClick={() => setFilters(DEFAULT_FILTERS)}>Clear</button>
      </div>

      {activeChips.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>Filtering by:</span>
          {activeChips.map((c) => (
            <span key={c.key} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none', fontFamily: 'var(--body)' }}>
              {c.label}
              <button type="button" className="ghost" title="Remove this filter"
                style={{ padding: '0 2px', lineHeight: 1, border: 'none', background: 'none', color: 'var(--muted)' }}
                onClick={() => setFilters({ ...filters, ...c.patch })}>×</button>
            </span>
          ))}
          <button className="ghost" style={chip} onClick={() => setFilters({ ...DEFAULT_FILTERS, q: filters.q })}>Clear filters</button>
        </div>
      )}

      {advancedOpen && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
          {showAccount && accounts.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Account</div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <button className={selectedAccountIds.length === 0 ? '' : 'ghost'} style={chip} onClick={() => setFilters({ ...filters, account_id: '' })}>All</button>
                {accounts.map((a) => {
                  const on = selectedAccountIds.includes(a.id);
                  return <button key={a.id} className={on ? '' : 'ghost'} style={chip} onClick={() => toggleAccount(a.id)}>{a.name}</button>;
                })}
              </div>
            </div>
          )}

          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Date range</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {RANGES.map(([k, label]) => (
              <button key={k} className={filters.range === k ? '' : 'ghost'} style={chip} onClick={() => setFilters({ ...filters, range: k })}>{label}</button>
            ))}
          </div>
          {filters.range === 'custom' && (
            <div className="grid grid-3" style={{ alignItems: 'end', marginTop: 10 }}>
              <Field label="From"><input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
              <Field label="To"><input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
            </div>
          )}

          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 12, marginBottom: 14 }}>
            <button className={filters.uncategorized ? '' : 'ghost'} style={chip}
              title="Show only transactions that still need a category"
              onClick={() => setFilters({ ...filters, uncategorized: filters.uncategorized ? '' : '1', transfers: '' })}>
              {filters.uncategorized ? '✓ ' : ''}Uncategorized only
            </button>
            <button className={filters.transfers ? '' : 'ghost'} style={chip}
              title="Show only transfers (money moved between your accounts)"
              onClick={() => setFilters({ ...filters, transfers: filters.transfers ? '' : '1', uncategorized: '' })}>
              {filters.transfers ? '✓ ' : ''}Transfers only
            </button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Amount</div>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={filters.amount_op} style={{ width: 'auto' }}
                onChange={(e) => setFilters({ ...filters, amount_op: e.target.value as AmountOp })}>
                {AMOUNT_OPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              {filters.amount_op && filters.amount_op !== 'between' && (
                <AmountInput value={filters.amount} placeholder="0.00" style={{ width: 130, textAlign: 'right' }}
                  onChange={(v) => setFilters({ ...filters, amount: v })} />
              )}
              {filters.amount_op === 'between' && (
                <>
                  <AmountInput value={filters.amount} placeholder="min" style={{ width: 110, textAlign: 'right' }}
                    onChange={(v) => setFilters({ ...filters, amount: v })} />
                  <span className="muted">and</span>
                  <AmountInput value={filters.amount_max} placeholder="max" style={{ width: 110, textAlign: 'right' }}
                    onChange={(v) => setFilters({ ...filters, amount_max: v })} />
                </>
              )}
            </div>
          </div>

          <PillMulti label="Channel" options={CHANNEL_OPTIONS.map(([v, name]) => ({ value: v, name }))} value={filters.channel} onChange={(v) => setFilters({ ...filters, channel: v })} />
          <PillMulti label="Category" options={leafCategories} value={filters.category_id} onChange={(v) => setFilters({ ...filters, category_id: v })} />
          {vehicles.length > 0 && <PillMulti label="Vehicle" options={vehicles.map((v) => ({ value: String(v.id), name: v.name }))} value={filters.vehicle_id} onChange={(v) => setFilters({ ...filters, vehicle_id: v })} />}
          {properties.length > 0 && <PillMulti label="Property" options={properties.map((p) => ({ value: String(p.id), name: p.name }))} value={filters.property_id} onChange={(v) => setFilters({ ...filters, property_id: v })} />}
          {tags.length > 0 && <PillMulti label="Tag" options={tags.map((t) => ({ value: String(t.id), name: t.name }))} value={filters.tag_id} onChange={(v) => setFilters({ ...filters, tag_id: v })} />}
        </div>
      )}
    </div>
  );
}
