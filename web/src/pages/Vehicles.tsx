import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate, todayStr, VEHICLE_DISPOSAL_TYPES, disposalTypeLabel } from '../api';
import { AmountInput, Field, CHART_COLORS, chartTooltip } from '../components/ui';
import { ColumnBar } from '../components/ColumnBar';

export interface Vehicle {
  id: number;
  name: string;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
  purchase_date: string | null;
  purchase_price: number | null;
  current_value: number | null;
  odometer_start: number | null;
  odometer_current: number | null;
  trim?: string | null;
  vehicle_type?: string | null;
  fuel_type?: string | null;
  license_plate?: string | null;
  engine_type?: string | null;
  transmission?: string | null;
  drivetrain?: string | null;
  exterior_color?: string | null;
  notes?: string | null;
  disposed_at?: string | null;
  disposal_type?: string | null;
  disposal_amount?: number | null;
  disposal_note?: string | null;
  disposal_transaction_id?: number | null;
  loan_account_id?: number | null;
  loan_account_name?: string | null;
  loan_account_balance?: number | null;
  total_spent?: number | null;       // sum of vehicle-tagged expenses (cost of ownership)
  last_odometer_at?: string | null;  // most recent odometer-reading date
  doc_count?: number;
}

export interface VehicleDoc { id: number; name: string | null; file_name: string | null; file_mime: string | null; created_at: string; doc_type?: string | null; maintenance_id?: number | null }

// Document categories used to group a vehicle's Documents section.
export const VEHICLE_DOC_TYPES: [string, string][] = [
  ['title', 'Title'],
  ['registration', 'Registration'],
  ['insurance', 'Insurance'],
  ['bill_of_sale', 'Bill of Sale'],
  ['maintenance', 'Maintenance'],
  ['warranty', 'Warranty'],
  ['photo', 'Photo'],
  ['other', 'Other'],
];
export const vehicleDocTypeLabel = (t: string | null | undefined) => VEHICLE_DOC_TYPES.find(([v]) => v === t)?.[1] ?? 'Other';

export interface VehicleWarranty {
  id?: number;
  coverage: string | null;
  provider: string | null;
  expiration: string | null;
  expires_miles: number | null; // odometer reading at which it expires
  cost: number | null;
  cost_in_purchase_price: boolean; // cost bundled into the vehicle's purchase price
  transaction_id: number | null;   // the transaction that paid for it (when not in purchase price)
  notes: string | null;
}

// String-form of a warranty row while editing it in the table.
type WarrantyRow = { coverage: string; provider: string; expiration: string; expires_miles: string; notes: string };

export const isDisposed = (v: Vehicle) => v.disposed_at != null;
// Effective loan owed on a vehicle: the linked liability account's balance, else 0.
export const loanOf = (v: Vehicle) => (v.loan_account_id != null ? (v.loan_account_balance ?? 0) : 0);

export interface Summary {
  vehicle: Vehicle;
  byCategory: { category_name: string | null; total: number; count: number }[];
  totalSpent: number;
  monthsOwned: number | null;
  milesDriven: number | null;
  depreciation: number | null;
  costPerMonth: number | null;
  costPerMile: number | null;
  maintenanceCost: number;
  maintenanceCount: number;
}

// Original − current (positive = value lost), when both are known.
export const depreciationOf = (v: Vehicle) =>
  v.purchase_price != null && v.current_value != null ? v.purchase_price - v.current_value : null;

// "2021 Toyota Tacoma" from the parts that exist, falling back to the label.
export const vehicleTitle = (v: Vehicle) => [v.year, v.make, v.model].filter(Boolean).join(' ') || v.name;

// Secondary line shown under the name. Prefer the year/make/model when it adds
// something beyond the name; otherwise fall back to the VIN. Empty when the name
// already says it all (e.g. a vehicle literally named "2024 Jeep Wrangler" with no
// VIN) — callers decide what, if anything, to show in that case.
export const vehicleSubtitle = (v: Vehicle): string =>
  [
    vehicleTitle(v) !== v.name ? vehicleTitle(v) : null,
    v.vin ? `VIN ${v.vin}` : null,
  ].filter(Boolean).join(' · ');

// Miles driven since purchase, when both odometer readings are known.
export const milesDrivenOf = (v: Vehicle) =>
  v.odometer_current != null && v.odometer_start != null ? v.odometer_current - v.odometer_start : null;

const numOrNull = (v: number | null | undefined) => (v == null ? null : Number(v));
// Equity = current value minus the linked loan balance (full value when no loan).
export const equityOf = (v: Vehicle) => (v.current_value == null ? null : v.current_value - loanOf(v));
// Depreciation as a percentage of purchase price.
export const depreciationPctOf = (v: Vehicle) => {
  const d = depreciationOf(v);
  return d != null && v.purchase_price ? (d / v.purchase_price) * 100 : null;
};
// Whole months owned (purchase → disposal/today), at least 1.
export const monthsOwnedOf = (v: Vehicle): number | null => {
  if (!v.purchase_date) return null;
  const start = new Date(v.purchase_date);
  const end = v.disposed_at ? new Date(v.disposed_at) : new Date();
  return Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
};
// Estimated monthly ownership cost from tracked (tagged) transactions.
export const monthlyCostOf = (v: Vehicle) => {
  const spent = numOrNull(v.total_spent); const m = monthsOwnedOf(v);
  return spent != null && m ? spent / m : null;
};
// Tracked cost per mile driven.
export const costPerMileOf = (v: Vehicle) => {
  const spent = numOrNull(v.total_spent); const mi = milesDrivenOf(v);
  return spent != null && mi && mi > 0 ? spent / mi : null;
};
// Projected miles per year from the run-rate so far.
export const estAnnualMilesOf = (v: Vehicle) => {
  const mi = milesDrivenOf(v); const m = monthsOwnedOf(v);
  return mi != null && m ? (mi / m) * 12 : null;
};
// Last 6 characters of the VIN (never show the full VIN on the list).
export const vinTail = (v: Vehicle) => (v.vin ? v.vin.slice(-6) : null);
// Short fuel label ("Gasoline" → "Gas").
export const fuelShort = (v: Vehicle) => {
  const f = v.fuel_type; if (!f) return null;
  const lf = f.toLowerCase();
  if (lf.startsWith('gas')) return 'Gas';
  if (lf.startsWith('diesel')) return 'Diesel';
  if (lf.startsWith('electric')) return 'Electric';
  if (lf.includes('hybrid')) return 'Hybrid';
  return f;
};
export const daysSince = (iso: string | null | undefined) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;
// Actionable attention items for an owned vehicle (missing or stale data).
export const warningsOf = (v: Vehicle): string[] => {
  if (isDisposed(v)) return [];
  const w: string[] = [];
  if (v.current_value == null) w.push('Needs current value');
  if (v.purchase_price == null) w.push('Missing purchase price');
  if (!v.vin) w.push('Missing VIN');
  if (v.odometer_current == null) w.push('Missing odometer');
  else if ((daysSince(v.last_odometer_at) ?? 999) > 60) w.push('Odometer not updated in 60+ days');
  return w;
};

const VEHICLE_FILTERS: [string, string][] = [
  ['owned', 'Currently Owned'],
  ['all', 'All Vehicles'],
  ['previous', 'Previously Owned'],
  ['financed', 'Financed'],
  ['outright', 'Owned Outright'],
  ['missing', 'Missing Information'],
  ['missing_value', 'Missing Current Value'],
  ['missing_odometer', 'Missing Odometer'],
];

// Value-retained chart tooltip: the full per-vehicle breakdown.
function RetainedTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--hairline-strong)', borderRadius: 6, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
      <div className="muted">Paid: <span className="num">{money(d.paid)}</span></div>
      <div className="muted">Current Value: <span className="num">{money(d.value)}</span></div>
      <div className="muted">Depreciation: <span className="num">{money(d.depreciation)}</span></div>
      {d.retained != null && <div className="muted">Retained: <span className="num">{d.retained.toFixed(1)}%</span></div>}
    </div>
  );
}

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [err, setErr] = useState('');
  // The "Previously Owned" section starts collapsed; the preference persists.
  const [showPrev, setShowPrev] = useState(() => localStorage.getItem('vehicles.showPreviouslyOwned') === '1');
  const togglePrev = () => setShowPrev((s) => { localStorage.setItem('vehicles.showPreviouslyOwned', s ? '0' : '1'); return !s; });
  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('vehicles.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('vehicles.hideCharts', v ? '1' : '0'); return !v; });
  const [filter, setFilter] = useState('owned');
  const location = useLocation();
  const navigate = useNavigate();

  const [milesDriven, setMilesDriven] = useState<{ month: string; miles: number }[]>([]);
  const load = () => api.get<Vehicle[]>('/vehicles').then(setVehicles).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    api.get<{ month: string; miles: number }[]>('/vehicles/miles-driven').then(setMilesDriven).catch(() => {});
  }, []);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = (m: string) => { const [y, mo] = m.split('-'); return `${MONTHS[Number(mo) - 1] ?? mo} ${y.slice(2)}`; };

  // Deep-link from the Asset Dashboard's "Add Asset → Vehicle" picker.
  useEffect(() => {
    if ((location.state as { add?: boolean } | null)?.add) {
      navigate('/vehicles/new', { replace: true, state: null });
    }
  }, [location, navigate]);

  const active = vehicles.filter((v) => !isDisposed(v));
  const previouslyOwned = vehicles.filter(isDisposed);

  // The page filter drives the list, summary cards, and value charts.
  const matchesFilter = (v: Vehicle) => {
    const d = isDisposed(v);
    switch (filter) {
      case 'all': return true;
      case 'previous': return d;
      case 'financed': return !d && v.loan_account_id != null;
      case 'outright': return !d && v.loan_account_id == null;
      case 'missing': return !d && warningsOf(v).length > 0;
      case 'missing_value': return !d && v.current_value == null;
      case 'missing_odometer': return !d && (v.odometer_current == null || (daysSince(v.last_odometer_at) ?? 999) > 60);
      case 'owned': default: return !d;
    }
  };
  const filtered = vehicles.filter(matchesFilter);
  const includeDisposed = filter === 'all' || filter === 'previous';
  // Summary/charts reflect the filtered set; disposed vehicles are excluded from the
  // value totals unless the filter explicitly includes them.
  const summarySet = includeDisposed ? filtered : filtered.filter((v) => !isDisposed(v));

  const sumValue = summarySet.reduce((s, v) => s + (v.current_value ?? 0), 0);
  const sumPaid = summarySet.reduce((s, v) => s + (v.purchase_price ?? 0), 0);
  const sumLoan = summarySet.reduce((s, v) => s + loanOf(v), 0);
  const sumEquity = sumValue - sumLoan;
  const netDep = sumPaid - sumValue;
  const netDepPct = sumPaid > 0 ? (netDep / sumPaid) * 100 : null;
  const monthlyCost = summarySet.reduce((s, v) => s + (monthlyCostOf(v) ?? 0), 0);
  const loanDataIncomplete = summarySet.some((v) => v.loan_account_id != null && v.loan_account_balance == null);
  const countNoun = filter === 'previous' ? 'previously owned' : includeDisposed ? 'vehicles' : 'active vehicles';

  // Value charts (client-side, from the filtered set).
  const round = (n: number) => Math.round(n * 100) / 100;
  const byValue = useMemo(
    () => summarySet.map((v) => ({ name: vehicleTitle(v), value: round(v.current_value ?? 0) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value),
    [vehicles, filter]
  );
  const missingValueCount = summarySet.filter((v) => v.current_value == null).length;
  const valueVsDep = useMemo(
    () => summarySet.map((v) => {
      const paid = v.purchase_price ?? 0; const cur = v.current_value ?? 0;
      return { name: vehicleTitle(v), paid, value: round(cur), depreciation: round(Math.max(0, paid - cur)), retained: paid > 0 ? (cur / paid) * 100 : null };
    }).filter((x) => x.value > 0 || x.depreciation > 0).sort((a, b) => (b.value + b.depreciation) - (a.value + a.depreciation)),
    [vehicles, filter]
  );

  // Mileage-trend stats (fleet-wide).
  const mtTotal = milesDriven.reduce((s, m) => s + m.miles, 0);
  const mtMonthly = milesDriven.length ? mtTotal / milesDriven.length : null;
  const mtAnnual = mtMonthly != null ? mtMonthly * 12 : null;
  const lastOdoUpdate = active.map((v) => v.last_odometer_at).filter(Boolean).sort().slice(-1)[0] as string | undefined;

  // Show the separate "Previously Owned" section only when the filter is
  // active-focused (otherwise disposed vehicles already appear in the list).
  const showPrevSection = !includeDisposed && previouslyOwned.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Assets</div>
          <h1 className="title">Vehicles</h1>
          <p className="subtitle">Your vehicles as a financial position — value, equity, depreciation, and what each costs to own.</p>
        </div>
        <button className="head-add" onClick={() => navigate('/vehicles/new')}>Add Vehicle</button>
      </div>

      {err && <div className="error">{err}</div>}

      {vehicles.length === 0 ? (
        <div className="card"><div className="empty">No vehicles yet. Add one, then tag fuel, insurance and maintenance transactions to it.</div></div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button className="ghost" onClick={toggleCharts}>{showCharts ? 'Hide Charts' : 'Show Charts'}</button>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 13 }}>Show</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto', minWidth: 175 }}>
                {VEHICLE_FILTERS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
            </div>
          </div>

          {summarySet.length > 0 && (
            <>
              <div className="grid grid-4" style={{ marginBottom: 8 }}>
                <div className="card stat">
                  <div className="label">Current Value</div>
                  <div className="value" style={{ fontSize: 22 }}>{money(sumValue)}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Across {summarySet.length} {countNoun}</div>
                </div>
                <div className="card stat">
                  <div className="label">Vehicle Equity</div>
                  <div className="value" style={{ fontSize: 22 }}>{money(sumEquity)}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{loanDataIncomplete ? <span className="warn">Loan data incomplete</span> : 'Value minus loan balances'}</div>
                </div>
                <div className="card stat">
                  <div className="label">Net Depreciation</div>
                  <div className={`value ${netDep > 0 ? 'debit' : 'credit'}`} style={{ fontSize: 22 }}>{money(netDep)}{netDepPct != null ? ` · ${netDepPct.toFixed(1)}%` : ''}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>From purchase price</div>
                </div>
                <div className="card stat">
                  <div className="label">Monthly Ownership Cost</div>
                  <div className="value" style={{ fontSize: 22 }}>{money(monthlyCost)}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Based on tracked transactions</div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>Total Paid: <span className="num">{money(sumPaid)}</span></div>
            </>
          )}

          {showCharts && (byValue.length > 0 || valueVsDep.length > 0 || missingValueCount > 0) && (
            <div className="grid grid-2" style={{ marginBottom: 18 }}>
              <div className="card">
                <div className="label" style={{ marginBottom: 8 }}>Value by Vehicle</div>
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
                  <div className="muted" style={{ fontSize: 13 }}>No vehicles have a current value yet.</div>
                )}
                {missingValueCount > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 10 }}><span className="warn">{missingValueCount}</span> vehicle{missingValueCount === 1 ? '' : 's'} missing a current value (not shown).</div>}
              </div>
              <div className="card">
                <div className="label" style={{ marginBottom: 8 }}>Value Retained vs Depreciation</div>
                {valueVsDep.length > 0 ? (
                  <div style={{ height: Math.max(200, valueVsDep.length * 40) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={valueVsDep} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                        <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                        <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                        <Tooltip content={<RetainedTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                        <Bar dataKey="value" stackId="v" fill="#6B7F6E" name="Current value" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="depreciation" stackId="v" fill="#A15648" name="Depreciation" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 13 }}>Add purchase prices and current values to compare value retained.</div>
                )}
              </div>
            </div>
          )}

          {showCharts && active.length > 0 && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="label" style={{ marginBottom: 8 }}>Mileage Trend</div>
              {milesDriven.length > 0 ? (
                <>
                  <div style={{ height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={milesDriven} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={monthLabel} minTickGap={16} />
                        <YAxis tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                        <Tooltip formatter={(v: number) => [`${Number(v).toLocaleString()} mi`, 'driven']} labelFormatter={(m) => monthLabel(String(m))} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                        <Bar dataKey="miles" fill="#5A6F87" shape={<ColumnBar />} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="row" style={{ gap: '4px 22px', flexWrap: 'wrap', fontSize: 12, marginTop: 8 }}>
                    {mtMonthly != null && <span><span className="muted">Monthly miles: </span><span className="num">{Math.round(mtMonthly).toLocaleString()} mi</span></span>}
                    {mtAnnual != null && <span><span className="muted">Estimated annual: </span><span className="num">{Math.round(mtAnnual).toLocaleString()} mi</span></span>}
                    {lastOdoUpdate && <span><span className="muted">Last odometer update: </span><span className="num">{shortDate(lastOdoUpdate)}</span></span>}
                  </div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 13 }}>Add at least two odometer readings on a vehicle's Odometer tab to see the mileage trend.</div>
              )}
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Tip: Update each vehicle's odometer at least monthly (on its Odometer tab) so miles driven stay accurate.
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="card"><div className="empty">No vehicles match this filter.</div></div>
          ) : (
            <div style={{ display: 'grid', gap: 16 }}>
              {filtered.map((v) => (
                isDisposed(v)
                  ? <PreviousVehicleCard key={v.id} vehicle={v} onOpen={() => navigate(`/vehicles/${v.id}`)} />
                  : <VehicleCard key={v.id} vehicle={v} onOpen={() => navigate(`/vehicles/${v.id}`)} />
              ))}
            </div>
          )}

          {showPrevSection && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '22px 0 8px' }}>
                <div className="label" style={{ margin: 0 }}>Previously Owned Vehicles · {previouslyOwned.length}</div>
                <button className="ghost" onClick={togglePrev}>{showPrev ? 'Hide' : 'Show'}</button>
              </div>
              {showPrev && (
                <div style={{ display: 'grid', gap: 16 }}>
                  {previouslyOwned.map((v) => (
                    <PreviousVehicleCard key={v.id} vehicle={v} onOpen={() => navigate(`/vehicles/${v.id}`)} />
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

// Owned-vehicle card: financial position first (value / loan / equity / depreciation),
// then usage details, then any missing-data attention items.
function VehicleCard({ vehicle: v, onOpen }: { vehicle: Vehicle; onOpen: () => void }) {
  const dep = depreciationOf(v);
  const eq = equityOf(v);
  const miles = milesDrivenOf(v);
  const hasLoan = v.loan_account_id != null;
  const warnings = warningsOf(v);
  const missing = <span className="warn">Needs value</span>;

  const headBits = ['Active', fuelShort(v), v.odometer_current != null ? `${v.odometer_current.toLocaleString()} mi` : null, vinTail(v) ? `VIN ending ${vinTail(v)}` : null]
    .filter(Boolean).join(' · ');

  const secondary: [string, string][] = [];
  if (v.purchase_date) secondary.push(['Purchased', shortDate(v.purchase_date)]);
  if (v.purchase_price != null) secondary.push(['Purchase Price', money(v.purchase_price)]);
  if (miles != null) secondary.push(['Miles Driven', `${miles.toLocaleString()} mi`]);
  const annual = estAnnualMilesOf(v); if (annual != null) secondary.push(['Est. Annual Miles', `${Math.round(annual).toLocaleString()} mi`]);
  const cpm = costPerMileOf(v); if (cpm != null) secondary.push(['Cost / Mile', `${money(cpm)}/mi`]);

  return (
    <div className="card kindcard income clickable" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="kindcard-head">
        <div style={{ minWidth: 0 }}>
          <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {vehicleTitle(v)}
            {!!v.doc_count && <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>📎 {v.doc_count}</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{headBits}</div>
        </div>
        <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>View Details →</button>
      </div>

      <div style={{ padding: '12px 14px' }}>
        <div className="grid grid-4" style={{ marginBottom: 10 }}>
          <div className="stat"><div className="label">Current Value</div><div className="value small">{v.current_value != null ? money(v.current_value) : missing}</div></div>
          <div className="stat"><div className="label">{hasLoan ? 'Loan Balance' : 'Ownership'}</div><div className="value small">{hasLoan ? money(loanOf(v)) : 'Owned outright'}</div></div>
          <div className="stat"><div className="label">Equity</div><div className="value small">{eq != null ? money(eq) : missing}</div></div>
          <div className="stat"><div className="label">Net Depreciation</div><div className={`value small ${dep != null && dep > 0 ? 'debit' : ''}`}>{dep != null ? money(dep) : missing}</div></div>
        </div>
        {secondary.length > 0 && (
          <div className="row" style={{ gap: '4px 20px', flexWrap: 'wrap', fontSize: 12 }}>
            {secondary.map(([k, val]) => <span key={k}><span className="muted">{k}: </span><span className="num">{val}</span></span>)}
          </div>
        )}
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

// Disposed-vehicle card: the ownership history and how it netted out.
function PreviousVehicleCard({ vehicle: v, onOpen }: { vehicle: Vehicle; onOpen: () => void }) {
  const miles = milesDrivenOf(v);
  const sale = v.disposal_amount;
  const gainLoss = sale != null && v.purchase_price != null ? sale - v.purchase_price : null;
  const spent = numOrNull(v.total_spent);
  const sold = (v.disposal_type ?? 'sold') === 'sold';
  const headBits = [disposalTypeLabel(v.disposal_type), fuelShort(v), vinTail(v) ? `VIN ending ${vinTail(v)}` : null].filter(Boolean).join(' · ');

  const facts: [string, string][] = [
    ['Owned', `${v.purchase_date ? shortDate(v.purchase_date) : '—'} → ${v.disposed_at ? shortDate(v.disposed_at) : '—'}`],
  ];
  if (v.purchase_price != null) facts.push(['Purchase Price', money(v.purchase_price)]);
  facts.push([sold ? 'Sale Value' : 'Proceeds', sale != null ? money(sale) : '—']);
  if (miles != null) facts.push(['Total Miles', `${miles.toLocaleString()} mi`]);
  if (spent != null && spent > 0) facts.push(['Tracked Cost', money(spent)]);

  return (
    <div className="card kindcard income clickable" style={{ cursor: 'pointer', opacity: 0.8 }} onClick={onOpen}>
      <div className="kindcard-head">
        <div style={{ minWidth: 0 }}>
          <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {vehicleTitle(v)}
            <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}>{disposalTypeLabel(v.disposal_type)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{headBits}</div>
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

interface ProceedsCandidate { id: number; txn_date: string; amount: number; direction: string; merchant: string | null; description: string | null; account_name: string | null }

// Retire a vehicle the user no longer owns (sold / traded / scrapped / …). Records
// how & when it left, ties the proceeds to a transaction (new, existing, or none),
// and lets the user attach a bill of sale — history is preserved, not deleted.
export type DisposeForm = {
  disposal_type: string; disposed_at: string; disposal_amount: string; disposal_note: string;
  proceeds_mode: 'none' | 'create' | 'link'; proceeds_account_id: string; disposal_transaction_id: string;
};
export const blankDisposeForm = (v: Vehicle): DisposeForm => ({
  disposal_type: v.disposal_type ?? 'sold',
  disposed_at: v.disposed_at?.slice(0, 10) ?? todayStr(),
  disposal_amount: v.disposal_amount?.toString() ?? '',
  disposal_note: v.disposal_note ?? '',
  proceeds_mode: 'none', proceeds_account_id: '', disposal_transaction_id: '',
});

// The "no longer owned" form, rendered inline under the Change Ownership button.
// Controlled by the parent (form/setForm) so the Details form's "Save Changes" button
// applies the disposal — this component just renders the fields. Cancel hides it.
export function VehicleDisposeFields({ vehicle, form: f, setForm, onClose }: {
  vehicle: Vehicle; form: DisposeForm; setForm: (f: DisposeForm) => void; onClose: () => void;
}) {
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [candidates, setCandidates] = useState<ProceedsCandidate[]>([]);
  const proceedsLabel = f.disposal_type === 'traded_in' ? 'Trade-in Value' : f.disposal_type === 'sold' ? 'Sale Price' : 'Proceeds';
  const set = (patch: Partial<DisposeForm>) => setForm({ ...f, ...patch });

  useEffect(() => {
    api.get<{ id: number; name: string; archived_at?: string | null }[]>('/accounts')
      .then((rows) => setAccounts(rows.filter((a) => !a.archived_at).map((a) => ({ id: a.id, name: a.name })))).catch(() => {});
    api.get<ProceedsCandidate[]>(`/vehicles/${vehicle.id}/proceeds-candidates`).then(setCandidates).catch(() => {});
  }, [vehicle.id]);

  const candidateLabel = (c: ProceedsCandidate) =>
    `${shortDate(c.txn_date)} · ${money(c.amount)} · ${c.merchant || c.description || c.account_name || 'transaction'}`;

  return (
    <>
      <div className="grid grid-4">
        <Field label="How It Left">
          <select value={f.disposal_type} onChange={(e) => set({ disposal_type: e.target.value })}>
            {VEHICLE_DISPOSAL_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Field>
        <Field label="Date"><input type="date" value={f.disposed_at} onChange={(e) => set({ disposed_at: e.target.value })} /></Field>
        <Field label={`${proceedsLabel} (Optional)`}><AmountInput value={f.disposal_amount} onChange={(v) => set({ disposal_amount: v })} placeholder="0.00" /></Field>
        <Field label="Record the Proceeds As">
          <select value={f.proceeds_mode} onChange={(e) => set({ proceeds_mode: e.target.value as DisposeForm['proceeds_mode'] })}>
            <option value="none">Just the Amount Above (No Transaction)</option>
            <option value="create">A New Income Transaction</option>
            <option value="link">Link an Existing Transaction</option>
          </select>
        </Field>
      </div>
      {f.proceeds_mode === 'create' && (
        <Field label="Deposit Account">
          <select value={f.proceeds_account_id} onChange={(e) => set({ proceeds_account_id: e.target.value })}>
            <option value="">Select an account…</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      {f.proceeds_mode === 'link' && (
        <Field label="Transaction">
          <select value={f.disposal_transaction_id} onChange={(e) => set({ disposal_transaction_id: e.target.value })}>
            <option value="">Select a transaction…</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
          </select>
          {candidates.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No income/transfer transactions found to link.</div>}
        </Field>
      )}

      <Field label="Note (Optional)"><input value={f.disposal_note} onChange={(e) => set({ disposal_note: e.target.value })} placeholder="e.g. sold to CarMax, traded for the new truck" /></Field>

      <div className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
        To attach the Bill of Sale, use the Documents section above — adding it completes the change of ownership.
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}
