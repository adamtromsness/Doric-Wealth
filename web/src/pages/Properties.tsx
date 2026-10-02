import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate, todayStr, PROPERTY_TYPES, propertyTypeLabel, propertyDisposalTypeLabel } from '../api';
import { CHART_COLORS, chartTooltip } from '../components/ui';

export interface Property {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  property_type: string;
  purchase_date: string | null;
  purchase_price: number | null;
  current_value: number | null;
  mortgage_balance: number | null;
  mortgage_account_id: number | null;
  mortgage_account_name: string | null;
  mortgage_account_balance: number | null;
  year_built: number | null;
  square_feet: number | null;
  lot_size_acres: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  stories: number | null;
  garage_spaces: number | null;
  is_new_construction: boolean;
  rental_income: number | null;
  is_rental: boolean;
  is_occupied: boolean | null;
  tenant_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  security_deposit: number | null;
  legal_description: string | null;
  property_tax_annual: number | null;
  hoa_dues: number | null;
  hoa_cycle: string | null;
  notes: string | null;
  disposed_at: string | null;
  // Automatic RentCast value updates (see PropertyAutoValue).
  auto_value_enabled?: boolean;
  auto_value_frequency?: 'weekly' | 'monthly';
  auto_value_last_success_at?: string | null;
  auto_value_last_error?: string | null;
  disposal_type: string | null;
  disposal_amount: number | null;
  disposal_note: string | null;
  total_spent: number;
  txn_count: number;
  doc_count: number;
}

export const isDisposedProp = (p: Property) => p.disposed_at != null;

export interface PropertyDoc { id: number; name: string | null; file_name: string | null; file_mime: string | null; created_at: string; doc_type?: string | null }

// Document categories for properties (value → label), ordered for grouping.
export const PROPERTY_DOC_TYPES: [string, string][] = [
  ['deed', 'Deed / Title'],
  ['closing', 'Closing / Settlement'],
  ['mortgage', 'Mortgage / Loan'],
  ['insurance', 'Insurance'],
  ['tax', 'Tax / Assessment'],
  ['survey', 'Survey / Inspection'],
  ['appraisal', 'Appraisal'],
  ['lease', 'Lease / Rental'],
  ['warranty', 'Warranty'],
  ['photo', 'Photo'],
  ['other', 'Other'],
];
export const propertyDocTypeLabel = (t: string | null | undefined) => PROPERTY_DOC_TYPES.find(([v]) => v === t)?.[1] ?? 'Other';

// Effective mortgage owed: from the linked account when present, else the field.
export const mortgageOf = (p: Property) => (p.mortgage_account_id != null ? (p.mortgage_account_balance ?? 0) : (p.mortgage_balance ?? 0));

export interface Summary {
  property: Property;
  byCategory: { category_name: string | null; total: number; count: number }[];
  totalSpent: number;
  totalIncome: number;
  net: number;
  monthsOwned: number | null;
  costPerMonth: number | null;
  equity: number | null;
  appreciation: number | null;
  annualRentalIncome: number | null;
  grossYield: number | null;
}

export const equityOf = (p: Property) => (p.current_value ?? 0) - mortgageOf(p);

// "123 Main St · City, ST 12345" from the parts that exist.
export const addressLine = (p: Property) => {
  const cityLine = [p.city, p.state].filter(Boolean).join(', ');
  return [p.address, [cityLine, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
};

const numOrNull = (v: number | null | undefined) => (v == null ? null : Number(v));
// Appreciation = current value − purchase price (positive = gained value), when both known.
export const appreciationOf = (p: Property) =>
  p.current_value != null && p.purchase_price != null ? p.current_value - p.purchase_price : null;
// Appreciation as a percentage of purchase price.
export const appreciationPctOf = (p: Property) => {
  const a = appreciationOf(p);
  return a != null && p.purchase_price ? (a / p.purchase_price) * 100 : null;
};
// Whole months owned (purchase → today), at least 1.
export const monthsOwnedOf = (p: Property): number | null => {
  if (!p.purchase_date) return null;
  const start = new Date(p.purchase_date);
  const end = new Date();
  return Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
};
// Estimated monthly ownership cost from tracked (tagged) transactions.
export const monthlyCostOf = (p: Property) => {
  const spent = numOrNull(p.total_spent); const m = monthsOwnedOf(p);
  return spent != null && m ? spent / m : null;
};
export const daysSince = (iso: string | null | undefined) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;
// Actionable attention items for a property (missing or stale data).
export const warningsOf = (p: Property): string[] => {
  const w: string[] = [];
  if (p.current_value == null) w.push('Needs current value');
  if (p.purchase_price == null) w.push('Missing purchase price');
  if (p.is_rental) {
    if (p.is_occupied === false) w.push('Vacant rental');
    else if (!p.tenant_name) w.push('Occupied, no tenant on file');
    if (p.lease_end && (daysSince(p.lease_end) ?? -1) > 0) w.push('Lease has ended');
  }
  return w;
};

const PROPERTY_FILTERS: [string, string][] = [
  ['owned', 'Currently Owned'],
  ['all', 'All Properties'],
  ['previous', 'Previously Owned'],
  ['rental', 'Rental Properties'],
  ['mortgaged', 'With a Mortgage'],
  ['outright', 'Owned Outright'],
  ['missing', 'Missing Information'],
  ['missing_value', 'Missing Current Value'],
];

export default function Properties() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [err, setErr] = useState('');
  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('properties.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('properties.hideCharts', v ? '1' : '0'); return !v; });
  const [filter, setFilter] = useState('owned');
  const [showPrev, setShowPrev] = useState(() => localStorage.getItem('properties.showPreviouslyOwned') === '1');
  const togglePrev = () => setShowPrev((s) => { localStorage.setItem('properties.showPreviouslyOwned', s ? '0' : '1'); return !s; });
  const location = useLocation();
  const navigate = useNavigate();

  const load = () => api.get<Property[]>('/properties').then(setProperties).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Deep-link from the Asset Dashboard's "Add Asset → Property".
  useEffect(() => {
    if ((location.state as { add?: boolean } | null)?.add) {
      navigate('/properties/new', { replace: true, state: null });
    }
  }, [location, navigate]);

  const previouslyOwned = properties.filter(isDisposedProp);

  // The page filter drives the list, summary cards, and value charts.
  const matchesFilter = (p: Property) => {
    const d = isDisposedProp(p);
    switch (filter) {
      case 'all': return true;
      case 'previous': return d;
      case 'rental': return !d && p.is_rental;
      case 'mortgaged': return !d && mortgageOf(p) > 0.005;
      case 'outright': return !d && mortgageOf(p) <= 0.005;
      case 'missing': return !d && warningsOf(p).length > 0;
      case 'missing_value': return !d && p.current_value == null;
      case 'owned': default: return !d;
    }
  };
  const filtered = properties.filter(matchesFilter);
  const includeDisposed = filter === 'all' || filter === 'previous';
  // Summary/charts reflect the filtered set; disposed properties are excluded from the
  // value totals unless the filter explicitly includes them.
  const summarySet = includeDisposed ? filtered : filtered.filter((p) => !isDisposedProp(p));
  // The separate "Previously Owned" section only shows when the filter is owned-focused.
  const showPrevSection = !includeDisposed && previouslyOwned.length > 0;

  const sumValue = summarySet.reduce((s, p) => s + (p.current_value ?? 0), 0);
  const sumPaid = summarySet.reduce((s, p) => s + (p.purchase_price ?? 0), 0);
  const sumMortgage = summarySet.reduce((s, p) => s + mortgageOf(p), 0);
  const sumEquity = sumValue - sumMortgage;
  const netAppr = sumValue - sumPaid;
  const netApprPct = sumPaid > 0 ? (netAppr / sumPaid) * 100 : null;
  const rentals = summarySet.filter((p) => p.is_rental);
  const monthlyRent = rentals.reduce((s, p) => s + (p.rental_income ?? 0), 0);
  const mortgageDataIncomplete = summarySet.some((p) => p.mortgage_account_id != null && p.mortgage_account_balance == null);

  // Value charts (client-side, from the filtered set).
  const round = (n: number) => Math.round(n * 100) / 100;
  const byValue = useMemo(
    () => summarySet.map((p) => ({ name: p.name, value: round(p.current_value ?? 0) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value),
    [properties, filter]
  );
  const missingValueCount = summarySet.filter((p) => p.current_value == null).length;
  const equityVsDebt = useMemo(
    () => summarySet.map((p) => ({ name: p.name, equity: round(Math.max(0, equityOf(p))), mortgage: round(mortgageOf(p)) }))
      .filter((x) => x.equity > 0 || x.mortgage > 0)
      .sort((a, b) => (b.equity + b.mortgage) - (a.equity + a.mortgage)),
    [properties, filter]
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Assets</div>
          <h1 className="title">Properties</h1>
          <p className="subtitle">Your real estate as a financial position — value, equity, appreciation, and what each costs to own.</p>
        </div>
        <button className="head-add" onClick={() => navigate('/properties/new')}>Add Property</button>
      </div>

      {err && <div className="error">{err}</div>}

      {properties.length === 0 ? (
        <div className="card"><div className="empty">No properties yet. Add one to track its value and equity.</div></div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button className="ghost" onClick={toggleCharts}>{showCharts ? 'Hide Charts' : 'Show Charts'}</button>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 13 }}>Show</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto', minWidth: 175 }}>
                {PROPERTY_FILTERS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
            </div>
          </div>

          {summarySet.length > 0 && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 8 }}>
                <div className="card stat">
                  <div className="label">Total Value</div>
                  <div className="value" style={{ fontSize: 22 }}>{money(sumValue)}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Across {summarySet.length} {summarySet.length === 1 ? 'property' : 'properties'}</div>
                </div>
                <div className="card stat">
                  <div className="label">Total Equity</div>
                  <div className="value" style={{ fontSize: 22 }}>{money(sumEquity)}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{mortgageDataIncomplete ? <span className="warn">Mortgage data incomplete</span> : 'Value minus mortgage balances'}</div>
                </div>
                <div className="card stat">
                  <div className="label">Net Appreciation</div>
                  <div className={`value ${netAppr >= 0 ? 'credit' : 'debit'}`} style={{ fontSize: 22 }}>{money(netAppr)}{netApprPct != null ? ` · ${netApprPct.toFixed(1)}%` : ''}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>From purchase price</div>
                </div>
                <div className="card stat">
                  <div className="label">Monthly Rental Income</div>
                  <div className="value credit" style={{ fontSize: 22 }}>{money(monthlyRent)}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{rentals.length ? `Across ${rentals.length} rental${rentals.length === 1 ? '' : 's'}` : 'No rentals'}</div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
                Total Mortgage: <span className="num">{money(sumMortgage)}</span>
                {sumPaid > 0 && <> · Total Paid: <span className="num">{money(sumPaid)}</span></>}
              </div>
            </>
          )}

          {showCharts && (byValue.length > 0 || equityVsDebt.length > 0 || missingValueCount > 0) && (
            <div className="grid grid-2" style={{ marginBottom: 18 }}>
              <div className="card">
                <div className="label" style={{ marginBottom: 8 }}>Value by Property</div>
                {byValue.length >= 2 ? (
                  <div style={{ height: 240 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={byValue} dataKey="value" nameKey="name" innerRadius={52} outerRadius={84} paddingAngle={2} stroke="none">
                          {byValue.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                          <Label position="center" value={money(sumValue)} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 600, fill: '#23262B' }} />
                        </Pie>
                        <Tooltip formatter={(v: number) => money(v)} contentStyle={chartTooltip} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} formatter={(value, entry: any) => `${value} · ${money(entry?.payload?.value ?? 0)}`} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : byValue.length === 1 ? (
                  <div style={{ padding: '6px 0 2px' }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span>{byValue[0].name}</span><span className="num" style={{ fontWeight: 600 }}>{money(byValue[0].value)}</span>
                    </div>
                    <div style={{ height: 12, borderRadius: 6, background: CHART_COLORS[0] }} />
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 13 }}>No properties have a current value yet.</div>
                )}
                {missingValueCount > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 10 }}><span className="warn">{missingValueCount}</span> propert{missingValueCount === 1 ? 'y' : 'ies'} missing a current value (not shown).</div>}
              </div>
              <div className="card">
                <div className="label" style={{ marginBottom: 8 }}>Equity vs Mortgage by Property</div>
                {equityVsDebt.length > 0 ? (
                  <div style={{ height: Math.max(240, equityVsDebt.length * 40) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={equityVsDebt} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                        <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                        <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                        <Tooltip formatter={(v: number, n) => [money(v), n === 'mortgage' ? 'owed' : 'equity']} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                        <Bar dataKey="equity" stackId="v" fill="#6B7F6E" name="equity" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="mortgage" stackId="v" fill="#A15648" name="mortgage" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 13 }}>Add values and mortgage balances to compare equity.</div>
                )}
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="card"><div className="empty">No properties match this filter.</div></div>
          ) : (
            <div style={{ display: 'grid', gap: 16 }}>
              {filtered.map((p) => (
                isDisposedProp(p)
                  ? <PreviousPropertyCard key={p.id} property={p} onOpen={() => navigate(`/properties/${p.id}`)} />
                  : <PropertyCard key={p.id} property={p} onOpen={() => navigate(`/properties/${p.id}`)} />
              ))}
            </div>
          )}

          {showPrevSection && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '22px 0 8px' }}>
                <div className="label" style={{ margin: 0 }}>Previously Owned Properties · {previouslyOwned.length}</div>
                <button className="ghost" onClick={togglePrev}>{showPrev ? 'Hide' : 'Show'}</button>
              </div>
              {showPrev && (
                <div style={{ display: 'grid', gap: 16 }}>
                  {previouslyOwned.map((p) => (
                    <PreviousPropertyCard key={p.id} property={p} onOpen={() => navigate(`/properties/${p.id}`)} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

// Property card: financial position first (value / mortgage / equity / appreciation),
// then property details, then any missing-data attention items.
function PropertyCard({ property: p, onOpen }: { property: Property; onOpen: () => void }) {
  const equity = equityOf(p);
  const appr = appreciationOf(p);
  const hasMortgage = mortgageOf(p) > 0.005 || p.mortgage_account_id != null;
  const warnings = warningsOf(p);
  const missing = <span className="warn">Needs value</span>;

  const secondary: [string, string][] = [];
  if (p.purchase_date) secondary.push([p.is_new_construction ? 'Completed' : 'Purchased', shortDate(p.purchase_date)]);
  if (p.purchase_price != null) secondary.push([p.is_new_construction ? 'Construction Cost' : 'Purchase Price', money(p.purchase_price)]);
  const bedBath = [p.bedrooms != null ? `${Number(p.bedrooms)} bd` : null, p.bathrooms != null ? `${Number(p.bathrooms)} ba` : null].filter(Boolean).join(' · ');
  if (bedBath) secondary.push(['Beds / Baths', bedBath]);
  if (p.year_built != null) secondary.push(['Year Built', String(p.year_built)]);
  if (p.square_feet != null) secondary.push(['Size', `${p.square_feet.toLocaleString()} sq ft`]);
  if (p.lot_size_acres != null) secondary.push(['Lot Size', `${Number(p.lot_size_acres)} acres`]);
  if (p.is_rental && p.rental_income != null) secondary.push(['Rental Income', `${money(p.rental_income)}/mo`]);
  if (p.is_rental && p.tenant_name) secondary.push(['Tenant', p.tenant_name]);
  if (p.is_rental && p.lease_end) secondary.push(['Lease Ends', shortDate(p.lease_end)]);
  const cost = monthlyCostOf(p); if (cost != null) secondary.push(['Monthly Cost', `${money(cost)}/mo`]);
  if (p.txn_count > 0) secondary.push(['Tagged Spending', `${money(p.total_spent)} · ${p.txn_count} txn`]);

  return (
    <div className="card kindcard income clickable" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="kindcard-head">
        <div style={{ minWidth: 0 }}>
          <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {p.name}
            {p.is_rental && (
              <span className="tag" style={p.is_occupied === false ? { borderColor: 'var(--debit)', color: 'var(--debit)' } : { borderColor: 'var(--income)', color: 'var(--income)' }}>
                Rental · {p.is_occupied === false ? 'Vacant' : 'Occupied'}
              </span>
            )}
            {p.is_new_construction && <span className="tag">New Construction</span>}
            {p.doc_count > 0 && <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>📎 {p.doc_count}</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {propertyTypeLabel(p.property_type)}{addressLine(p) ? ` · ${addressLine(p)}` : ''}
          </div>
        </div>
        <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>View Details →</button>
      </div>

      <div style={{ padding: '12px 14px' }}>
        <div className="grid grid-4" style={{ marginBottom: 10 }}>
          <div className="stat"><div className="label">Current Value</div><div className="value small">{p.current_value != null ? money(p.current_value) : missing}</div></div>
          <div className="stat">
            <div className="label">{hasMortgage ? `Mortgage${p.mortgage_account_id != null ? ' ·acct' : ''}` : 'Ownership'}</div>
            {hasMortgage
              ? (p.mortgage_account_id != null && mortgageOf(p) <= 0.005
                  ? <div className="value small credit">Paid off</div>
                  : <div className="value small debit">{money(mortgageOf(p))}</div>)
              : <div className="value small">Owned outright</div>}
          </div>
          <div className="stat"><div className="label">Equity</div><div className={`value small ${equity < 0 ? 'debit' : 'credit'}`}>{p.current_value != null ? money(equity) : missing}</div></div>
          <div className="stat"><div className="label">Net Appreciation</div><div className={`value small ${appr != null ? (appr >= 0 ? 'credit' : 'debit') : ''}`}>{appr != null ? money(appr) : missing}</div></div>
        </div>
        {secondary.length > 0 && (
          <div className="row" style={{ gap: '4px 20px', flexWrap: 'wrap', fontSize: 12 }}>
            {secondary.map(([k, val]) => <span key={k}><span className="muted">{k}: </span><span className="num">{val}</span></span>)}
          </div>
        )}
        {p.notes && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{p.notes}</div>}
        {warnings.length > 0 && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="warn" style={{ fontSize: 12, fontWeight: 600 }}>⚠ Needs attention:</span>
              {warnings.map((wn) => <span key={wn} className="tag" style={{ borderColor: 'var(--brass-deep)', color: 'var(--brass-deep)', textTransform: 'none' }}>{wn}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Disposed-property card: the ownership history and how it netted out.
function PreviousPropertyCard({ property: p, onOpen }: { property: Property; onOpen: () => void }) {
  const sale = p.disposal_amount;
  const gainLoss = sale != null && p.purchase_price != null ? sale - p.purchase_price : null;
  const spent = numOrNull(p.total_spent);

  const facts: [string, string][] = [
    ['Owned', `${p.purchase_date ? shortDate(p.purchase_date) : '—'} → ${p.disposed_at ? shortDate(p.disposed_at) : '—'}`],
  ];
  if (p.purchase_price != null) facts.push(['Purchase Price', money(p.purchase_price)]);
  facts.push(['Sale Value', sale != null ? money(sale) : '—']);
  if (spent != null && spent > 0) facts.push(['Tracked Cost', money(spent)]);

  return (
    <div className="card kindcard income clickable" style={{ cursor: 'pointer', opacity: 0.8 }} onClick={onOpen}>
      <div className="kindcard-head">
        <div style={{ minWidth: 0 }}>
          <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {p.name}
            <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}>{propertyDisposalTypeLabel(p.disposal_type)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {propertyTypeLabel(p.property_type)}{addressLine(p) ? ` · ${addressLine(p)}` : ''}
          </div>
        </div>
        <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>View Details →</button>
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div className="row" style={{ gap: '4px 20px', flexWrap: 'wrap', fontSize: 12, marginBottom: gainLoss != null ? 8 : 0 }}>
          {facts.map(([k, val]) => <span key={k}><span className="muted">{k}: </span><span className="num">{val}</span></span>)}
        </div>
        {gainLoss != null && (
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 13, paddingTop: 8, borderTop: '1px solid var(--hairline)' }}>
            <span className="muted">{gainLoss >= 0 ? 'Net gain vs paid' : 'Net loss vs paid'}</span>
            <span className={`num ${gainLoss >= 0 ? 'credit' : 'debit'}`}>{money(Math.abs(gainLoss))}</span>
          </div>
        )}
      </div>
    </div>
  );
}
