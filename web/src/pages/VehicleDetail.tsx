import { Fragment, useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, money, shortDate, todayStr, parseLocalDate, disposalTypeLabel } from '../api';
import { useAiConfigured, AiKeyHint } from '../aiStatus';
import { AiOutput, BackLink, chartTooltip, Modal, Field, AmountInput, EditorSection, fileToBase64, Loading } from '../components/ui';
import { type SnapItem } from '../components/SnapshotSection';
import { SnapshotTab } from '../components/SnapshotTab';
import { EntityDocuments } from '../components/EntityDocuments';
import { EntityInsurance } from '../components/EntityInsurance';
import { TxnEditor } from './transactions/TxnEditor';
import { TxnTable } from './transactions/TxnTable';
import { Pager } from './transactions/common';
import { PAGE_SIZE } from './transactions/helpers';
import type { Lookups, Txn } from './transactions/helpers';
import { VehicleDisposeFields, blankDisposeForm, isDisposed, depreciationOf, milesDrivenOf, loanOf, vehicleSubtitle, VEHICLE_DOC_TYPES, vehicleDocTypeLabel, type Vehicle, type VehicleDoc, type VehicleWarranty, type Summary, type DisposeForm } from './Vehicles';

interface TxnPage { pending: Txn[]; pendingTotal: number; posted: Txn[]; total: number }

interface Maintenance {
  id: number; item: string; status: 'completed' | 'upcoming';
  service_date: string | null; odometer: number | null; cost: number | null;
  transaction_id: number | null; due_date: string | null; due_odometer: number | null;
  vendor: string | null; notes: string | null;
  txn_date: string | null; txn_amount: number | null; txn_merchant: string | null;
  doc_count?: number;
}
interface ExpenseCandidate { id: number; txn_date: string; amount: number; merchant: string | null; description: string | null; account_name: string | null }

type Tab = 'overview' | 'transactions' | 'value' | 'maintenance' | 'odometer' | 'insurance' | 'documents' | 'details';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'value', label: 'Value' },
  { key: 'odometer', label: 'Odometer' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'documents', label: 'Documents' },
  { key: 'details', label: 'Details' },
];

const milesFmt = (n: number) => `${Math.round(n).toLocaleString()} mi`;
const odoTick = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((parseLocalDate(toIso).getTime() - parseLocalDate(fromIso).getTime()) / 86_400_000);

// Live status of one warranty given the vehicle's current odometer / today.
interface WarrantyStatus { daysLeft: number | null; milesLeft: number | null; expired: boolean; expiringSoon: boolean }
function warrantyStatus(w: VehicleWarranty, odometer: number | null): WarrantyStatus {
  const today = todayStr();
  const daysLeft = w.expiration ? daysBetween(today, w.expiration) : null;
  const milesLeft = w.expires_miles != null && odometer != null ? w.expires_miles - odometer : null;
  const expired = (daysLeft != null && daysLeft < 0) || (milesLeft != null && milesLeft < 0);
  // "Soon" = within 60 days or 1,000 miles of either limit (and not already expired).
  const expiringSoon = !expired && ((daysLeft != null && daysLeft <= 60) || (milesLeft != null && milesLeft <= 1000));
  return { daysLeft, milesLeft, expired, expiringSoon };
}

// One transaction row renderer, shared by the Overview "recent" list and the
// Transactions tab. Same amount sign/colour convention as PropertyDetail. Rows are
// clickable when onEdit is provided — opening the transaction editor.

function FactList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="detail-list">
      {items.map((f, i) => (<div key={i} className="detail-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>))}
    </dl>
  );
}

// A plain titled section. `headClassName`/`headStyle` let it match the surrounding
// heading style.
function Section({ title, children, headClassName = 'label', headStyle }: {
  title: string; children: ReactNode; headClassName?: string; headStyle?: CSSProperties;
}) {
  return (
    <>
      <div className={headClassName} style={headStyle}>{title}</div>
      {children}
    </>
  );
}

export default function VehicleDetail() {
  const { vehicleId } = useParams();
  const isNew = vehicleId === 'new';
  const id = Number(vehicleId);
  const navigate = useNavigate();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [txns, setTxns] = useState<TxnPage | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [docs, setDocs] = useState<VehicleDoc[]>([]);
  const [warranties, setWarranties] = useState<VehicleWarranty[]>([]);
  const [readings, setReadings] = useState<SnapItem[]>([]);
  const [values, setValues] = useState<SnapItem[]>([]);
  const [analysis, setAnalysis] = useState('');
  const [running, setRunning] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimateMsg, setEstimateMsg] = useState('');
  const aiConfigured = useAiConfigured();
  const [tab, setTab] = useState<Tab>('overview');
  const [disposing, setDisposing] = useState(false);
  const [addingTxn, setAddingTxn] = useState(false);
  const [editingTxn, setEditingTxn] = useState<Txn | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [merchants, setMerchants] = useState<string[]>([]);
  const [err, setErr] = useState('');
  // Transactions tab: server-side paginated (PAGE_SIZE per page), independent groups.
  const [pendingPage, setPendingPage] = useState(0);
  const [postedPage, setPostedPage] = useState(0);

  const loadVehicle = () => api.get<Vehicle[]>('/vehicles')
    .then((all) => { const v = all.find((x) => x.id === id) ?? null; setVehicle(v); if (!v) setErr('Vehicle not found.'); })
    .catch((e) => setErr(e.message));
  const loadTxns = () => api.get<TxnPage>(
    `/transactions?vehicle_id=${id}&limit=${PAGE_SIZE}&pendingOffset=${pendingPage * PAGE_SIZE}&postedOffset=${postedPage * PAGE_SIZE}`,
  ).then(setTxns).catch(() => {});
  const loadSummary = () => api.get<Summary>(`/vehicles/${id}/summary`).then(setSummary).catch(() => {});
  const loadDocs = () => api.get<VehicleDoc[]>(`/vehicles/${id}/documents`).then(setDocs).catch(() => {});
  const loadWarranties = () => api.get<VehicleWarranty[]>(`/vehicles/${id}/warranties`).then(setWarranties).catch(() => {});
  const loadReadings = () => api.get<SnapItem[]>(`/vehicles/${id}/odometer`).then(setReadings).catch(() => {});
  const loadValues = () => api.get<SnapItem[]>(`/vehicles/${id}/values`).then(setValues).catch(() => {});

  useEffect(() => {
    if (isNew) return; // "new" mode renders an empty info form; nothing to load
    if (!Number.isFinite(id)) { setErr('Invalid vehicle.'); return; }
    loadVehicle(); loadSummary(); loadDocs(); loadWarranties(); loadReadings(); loadValues();
  }, [id]);

  // Reload the current transaction page when the vehicle or either page changes.
  useEffect(() => { if (!isNew && Number.isFinite(id)) loadTxns(); }, [id, pendingPage, postedPage]);

  // Warranty editing — its rows live here so the Details form's "Save Changes" button
  // can persist them alongside the vehicle (no separate Save Warranties button).
  const [wrows, setWrows] = useState<WRow[]>([]);
  useEffect(() => { setWrows(seedWRows(warranties)); }, [warranties]);
  const setWRow = (i: number, patch: Partial<WRow>) => setWrows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeWRow = (i: number) => setWrows((rs) => rs.filter((_, j) => j !== i));
  const addWRow = () => setWrows((rs) => [...rs, blankWRow()]);
  const wNum = (s: string) => (s === '' ? null : Number(s));
  const warrantyCanonical = (rs: WRow[]) => rs.filter((r) => !isBlankWRow(r)).map((r) => ({
    coverage: r.coverage || null, provider: r.provider || null, expiration: r.expiration || null, expires_miles: wNum(r.expires_miles),
    cost: wNum(r.cost), cost_in_purchase_price: r.cost_in_purchase_price, transaction_id: r.cost_in_purchase_price ? null : wNum(r.transaction_id),
    notes: r.notes || null,
  }));
  const warrantySavedJson = JSON.stringify(warranties.map((w) => ({
    coverage: w.coverage || null, provider: w.provider || null, expiration: w.expiration ? w.expiration.slice(0, 10) : null, expires_miles: w.expires_miles ?? null,
    cost: w.cost != null ? Number(w.cost) : null, cost_in_purchase_price: !!w.cost_in_purchase_price, transaction_id: w.cost_in_purchase_price ? null : (w.transaction_id ?? null),
    notes: w.notes || null,
  })));
  const warrantyDirty = JSON.stringify(warrantyCanonical(wrows)) !== warrantySavedJson;
  const saveWarranties = async () => { await api.put(`/vehicles/${id}/warranties`, { warranties: warrantyCanonical(wrows) }); await loadWarranties(); };

  // Disposal ("no longer owned") is staged inline under Change Ownership and applied
  // by the Details form's Save Changes button (after an archive confirmation).
  const [disposeForm, setDisposeForm] = useState<DisposeForm>(() => ({
    disposal_type: 'sold', disposed_at: todayStr(), disposal_amount: '', disposal_note: '',
    proceeds_mode: 'none', proceeds_account_id: '', disposal_transaction_id: '',
  }));
  const dnum = (s: string) => (s === '' ? null : Number(s));
  const saveDispose = async () => {
    const d = disposeForm;
    if (d.proceeds_mode === 'create' && !d.proceeds_account_id) throw new Error('Pick the account the proceeds went into.');
    if (d.proceeds_mode === 'create' && dnum(d.disposal_amount) == null) throw new Error('Enter the sale amount to record a transaction.');
    if (d.proceeds_mode === 'link' && !d.disposal_transaction_id) throw new Error('Pick the transaction to link.');
    await api.post(`/vehicles/${id}/dispose`, {
      disposed: true, disposal_type: d.disposal_type, disposed_at: d.disposed_at || null,
      disposal_amount: dnum(d.disposal_amount), disposal_note: d.disposal_note || null,
      proceeds_mode: d.proceeds_mode,
      proceeds_account_id: d.proceeds_mode === 'create' ? dnum(d.proceeds_account_id) : null,
      disposal_transaction_id: d.proceeds_mode === 'link' ? dnum(d.disposal_transaction_id) : null,
    });
  };

  // Lookups for the "Add transaction" editor (loaded lazily the first time the
  // Transactions tab is opened, so other tabs don't pay for it).
  useEffect(() => {
    if (isNew || tab !== 'transactions' || lookups) return;
    Promise.all([
      api.get<any[]>('/categories').catch(() => []),
      api.get<any[]>('/accounts').catch(() => []),
      api.get<any[]>('/vehicles').catch(() => []),
      api.get<any[]>('/properties').catch(() => []),
      api.get<any[]>('/subscriptions').catch(() => []),
      api.get<any[]>('/tags').catch(() => []),
    ]).then(([categories, accounts, vehicles, properties, subscriptions, tags]) => {
      setLookups({ categories, accounts, vehicles, properties, subscriptions, tags: tags.filter((t: any) => !t.archived) } as Lookups);
    });
    api.get<string[]>('/transactions/merchants').then(setMerchants).catch(() => {});
  }, [tab]);

  // Maintenance edits happen in their own tab; refresh the summary (which includes
  // recorded maintenance cost, shown in the Overview's cost section) on Overview.
  useEffect(() => { if (!isNew && tab === 'overview') loadSummary(); }, [tab]);

  // A new/removed odometer reading changes the current odometer, which drives
  // miles-driven and cost-per-mile — so refresh the vehicle, summary, and list.
  const addReading = async (as_of: string, value: number) => {
    await api.post(`/vehicles/${id}/odometer`, { reading: value, as_of });
    loadReadings(); loadVehicle(); loadSummary();
  };
  const delReading = async (readingId: number) => {
    try { await api.del(`/vehicles/${id}/odometer/${readingId}`); loadReadings(); loadVehicle(); loadSummary(); } catch (e: any) { setErr(e.message); }
  };

  // A value snapshot drives current value → depreciation → cost-of-ownership, so
  // refresh the vehicle (current_value) and summary after add/delete.
  const addValue = async (as_of: string, value: number) => {
    await api.post(`/vehicles/${id}/values`, { value, as_of });
    loadValues(); loadVehicle(); loadSummary();
  };
  const delValue = async (valueId: number) => {
    try { await api.del(`/vehicles/${id}/values/${valueId}`); loadValues(); loadVehicle(); loadSummary(); } catch (e: any) { setErr(e.message); }
  };
  // AI value estimate recorded as a value snapshot (needs an Anthropic key).
  const estimateValue = async () => {
    if (!vehicle) return;
    setEstimating(true); setErr(''); setEstimateMsg('');
    try {
      const r = await api.post<{ value: number; low: number | null; high: number | null; rationale: string | null }>('/vehicles/estimate-value', {
        make: vehicle.make, model: vehicle.model, year: vehicle.year,
        odometer_current: vehicle.odometer_current, purchase_price: vehicle.purchase_price, purchase_date: vehicle.purchase_date,
      });
      await api.post(`/vehicles/${id}/values`, { value: r.value, as_of: todayStr() });
      loadValues(); loadVehicle(); loadSummary();
      const range = r.low != null && r.high != null ? ` (range ${money(r.low)}–${money(r.high)})` : '';
      setEstimateMsg(`Estimated ${money(r.value)}${range}.${r.rationale ? ' ' + r.rationale : ''}`);
    } catch (e: any) { setErr(e.message); }
    finally { setEstimating(false); }
  };

  const runTco = async () => {
    setRunning(true); setErr('');
    try {
      const res = await api.post<{ summary: Summary; result: string }>(`/analysis/vehicle/${id}/cost-of-ownership`);
      setAnalysis(res.result);
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  // Restore a retired vehicle back to active ownership.
  const restore = async () => {
    try { await api.post(`/vehicles/${id}/dispose`, { disposed: false }); loadVehicle(); loadSummary(); } catch (e: any) { setErr(e.message); }
  };

  // "Add Vehicle" — render the info form directly on the page (no popup). Saving
  // creates the vehicle and navigates to its full detail page.
  if (isNew) {
    return (
      <>
        <BackLink to="/vehicles" label="Back to Vehicles" />
        <div className="page-head" style={{ marginTop: 10 }}>
          <div>
            <h1 className="title">Add Vehicle</h1>
            <p className="subtitle">Enter the details and Save. You can add odometer readings, maintenance, warranties and documents after saving.</p>
          </div>
        </div>
        <VehicleInfoForm vehicle={null} isNew onSaved={(nv) => navigate(`/vehicles/${nv.id}`)} />
      </>
    );
  }

  if (err && !vehicle) {
    return (<><BackLink to="/vehicles" label="Back to Vehicles" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>);
  }
  if (!vehicle) return <Loading />;

  const v = vehicle;
  const disposed = isDisposed(v);
  // The Details "Save Changes" button also persists staged warranty + disposal edits.
  const disposeStaged = !disposed && disposing;
  const saveExtras = async () => {
    await saveWarranties();
    if (disposeStaged) { await saveDispose(); setDisposing(false); loadTxns(); loadDocs(); }
  };
  const confirmExtras = () => (disposeStaged
    ? window.confirm("Saving will mark this vehicle as no longer owned and move it to archived status. You'll need to reactivate it (Mark as Owned Again) to make further edits. Continue?")
    : true);
  const subtitle = vehicleSubtitle(v);
  const dep = depreciationOf(v);
  const miles = milesDrivenOf(v);
  const tco = summary ? summary.totalSpent + (summary.depreciation ?? 0) : null;

  // Pending transactions first (newest-first within each group), then posted —
  // mirroring the Transactions page so a pending item never drops out of "Recent".
  const byDateDesc = (x: Txn, y: Txn) => (x.txn_date < y.txn_date ? 1 : -1);
  const pendingTxns = (txns?.pending ?? []).slice().sort(byDateDesc);
  const postedTxns = (txns?.posted ?? []).slice().sort(byDateDesc);
  const allTxns = [...pendingTxns, ...postedTxns];
  const recentTxns = allTxns.slice(0, 8);
  // Transactions tab: server totals drive the pager (each group paged separately).
  const pendingTotal = txns?.pendingTotal ?? 0;
  const postedTotal = txns?.total ?? 0;
  const pendingPageCount = Math.max(1, Math.ceil(pendingTotal / PAGE_SIZE));
  const postedPageCount = Math.max(1, Math.ceil(postedTotal / PAGE_SIZE));

  // Overview facts — only push values that exist.
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Depreciation', value: dep != null ? <span className={dep > 0 ? 'debit' : 'credit'}>{money(dep)}</span> : '—' },
  ];
  if (v.purchase_price != null) facts.push({ label: 'Purchase Price', value: `${money(v.purchase_price)}${v.purchase_date ? ` · ${shortDate(v.purchase_date)}` : ''}` });
  if (v.loan_account_id != null) facts.push({ label: 'Loan Owed', value: loanOf(v) <= 0.005 ? <span className="credit">Paid off</span> : <span className="debit">{money(loanOf(v))}</span> });
  if (miles != null) facts.push({ label: 'Miles Driven', value: `${miles.toLocaleString()} mi` });
  if (summary?.monthsOwned != null) facts.push({ label: 'Owned', value: `${summary.monthsOwned} mo` });
  if (summary && summary.totalSpent > 0) facts.push({ label: 'Tagged Spending', value: money(summary.totalSpent) });
  if (tco != null) facts.push({ label: 'Total Cost of Ownership', value: money(tco) });

  // Details (read-only metadata). Core fields always shown; optional ones only when present.
  const details: { label: string; value: ReactNode }[] = [
    { label: 'Name', value: v.name },
    { label: 'Make / Model', value: [v.make, v.model].filter(Boolean).join(' ') || '—' },
  ];
  const opt = (label: string, value: ReactNode) => { if (value != null && value !== '') details.push({ label, value }); };
  opt('Year', v.year != null ? String(v.year) : null);
  opt('VIN', v.vin);
  opt('Purchase Price', v.purchase_price != null ? money(v.purchase_price) : null);
  opt('Purchase Date', v.purchase_date ? shortDate(v.purchase_date) : null);
  opt('Odometer Start', v.odometer_start != null ? `${v.odometer_start.toLocaleString()} mi` : null);
  opt('Odometer Current', v.odometer_current != null ? `${v.odometer_current.toLocaleString()} mi` : null);
  if (disposed) {
    opt('No Longer Owned', `${disposalTypeLabel(v.disposal_type)}${v.disposed_at ? ` · ${shortDate(v.disposed_at)}` : ''}`);
    opt('Proceeds', v.disposal_amount != null ? `${money(v.disposal_amount)}${v.disposal_transaction_id != null ? ' · recorded as a transaction' : ''}` : null);
    opt('Disposal Note',v.disposal_note);
  }
  opt('Notes', v.notes);

  return (
    <>
      <BackLink to="/vehicles" label="Back to Vehicles" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {v.name}
            {disposed && <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}>{disposalTypeLabel(v.disposal_type)}</span>}
          </h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
          <div style={{ marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>Value</span>
            <span className="num" style={{ fontSize: 26, fontWeight: 600 }}>{v.current_value != null ? money(v.current_value) : '—'}</span>
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {disposed && (
        <div className="banner" style={{ marginBottom: 12 }}>
          No longer owned · {disposalTypeLabel(v.disposal_type)}{v.disposed_at ? ` on ${shortDate(v.disposed_at)}` : ''}
          {v.disposal_amount != null ? ` for ${money(v.disposal_amount)}` : ''}
          {v.disposal_note ? ` — ${v.disposal_note}` : ''}. Its history is preserved; it no longer counts toward net worth. Use “Mark as Owned Again” to reverse this.
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Value</div><div className="value credit">{money(v.current_value)}</div></div>
            <div className="card stat"><div className="label">Paid</div><div className="value">{money(v.purchase_price)}</div></div>
            <div className="card stat"><div className="label">Depreciation</div><div className={`value ${dep != null && dep > 0 ? 'debit' : ''}`}>{dep != null ? money(dep) : '—'}</div></div>
          </div>

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="label" style={{ marginBottom: 10 }}>Summary</div>
            <FactList items={facts} />
          </div>

          {summary && (
            <>
              <div className="section" style={{ margin: '0 0 12px' }}>Cost of Ownership</div>
              <div className="grid grid-3" style={{ marginBottom: 12 }}>
                <div className="card stat"><div className="label">Total Cost of Ownership</div><div className="value">{money(tco)}</div></div>
                <div className="card stat"><div className="label">Cost / Month</div><div className="value">{money(summary.costPerMonth)}</div></div>
                <div className="card stat"><div className="label">Cost / Mile</div><div className="value">{summary.costPerMile != null ? money(summary.costPerMile) : '—'}</div></div>
              </div>
              <div className="grid grid-2" style={{ marginBottom: 12 }}>
                <div className="card stat"><div className="label">Spent (Excl. Depreciation)</div><div className="value small">{money(summary.totalSpent)}</div></div>
                <div className="card stat"><div className="label">Owned / Driven</div><div className="value small">{summary.monthsOwned ?? '—'} mo · {summary.milesDriven != null ? summary.milesDriven.toLocaleString() + ' mi' : '—'}</div></div>
              </div>
              <div className="grid grid-2" style={{ marginBottom: 18 }}>
                <div className="card stat">
                  <div className="label">Recorded Maintenance</div>
                  <div className="value small">{money(summary.maintenanceCost)}{summary.maintenanceCount ? ` · ${summary.maintenanceCount} item${summary.maintenanceCount === 1 ? '' : 's'}` : ''}</div>
                </div>
                <div className="card stat">
                  <div className="label">Maintenance / Mile</div>
                  <div className="value small">{summary.milesDriven && summary.milesDriven > 0 ? money(summary.maintenanceCost / summary.milesDriven) : '—'}</div>
                </div>
              </div>

              <div className="card" style={{ padding: 0, marginBottom: 18 }}>
                <table className="ledger">
                  <thead><tr><th>Spending by Category</th><th className="r">Transactions</th><th className="r">Total</th></tr></thead>
                  <tbody>
                    {summary.byCategory.map((c, i) => (
                      <tr key={i}><td>{c.category_name ?? 'Uncategorized'}</td><td className="r num">{c.count}</td><td className="r money num">{money(c.total)}</td></tr>
                    ))}
                    {summary.byCategory.length === 0 && <tr><td colSpan={3}><div className="empty">No transactions tagged to this vehicle yet.</div></td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div className="section" style={{ margin: 0 }}>AI Cost-of-Ownership Analysis</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Sends this vehicle's figures and recent transactions to Claude for a written breakdown.</div>
                  </div>
                  <button className="brass" onClick={runTco} disabled={running}>{running ? 'Analyzing…' : 'Run Analysis'}</button>
                </div>
                {analysis && <div style={{ marginTop: 16 }}><AiOutput markdown={analysis} /></div>}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'transactions' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>New transactions are automatically tagged to this vehicle.</div>
            <button onClick={() => setAddingTxn(true)} disabled={!lookups}>{lookups ? 'Add Transaction' : 'Loading…'}</button>
          </div>
          {pendingTxns.length > 0 && (
            <div style={{ marginBottom: postedTxns.length ? 18 : 0 }}>
              <div className="label" style={{ marginBottom: 8, color: 'var(--brass-deep)' }}>
                Pending · {pendingTotal} awaiting posting
              </div>
              <Pager top page={pendingPage} pageCount={pendingPageCount} total={pendingTotal}
                start={pendingPage * PAGE_SIZE} count={pendingTxns.length} onPage={setPendingPage} />
              <TxnTable items={pendingTxns} onEdit={lookups ? setEditingTxn : undefined} />
              <Pager page={pendingPage} pageCount={pendingPageCount} total={pendingTotal}
                start={pendingPage * PAGE_SIZE} count={pendingTxns.length} onPage={setPendingPage} />
            </div>
          )}
          {postedTxns.length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 8 }}>{pendingTxns.length > 0 ? 'Posted' : 'Transactions'}</div>
              <Pager top page={postedPage} pageCount={postedPageCount} total={postedTotal}
                start={postedPage * PAGE_SIZE} count={postedTxns.length} onPage={setPostedPage} />
              <TxnTable items={postedTxns} onEdit={lookups ? setEditingTxn : undefined} />
              <Pager page={postedPage} pageCount={postedPageCount} total={postedTotal}
                start={postedPage * PAGE_SIZE} count={postedTxns.length} onPage={setPostedPage} />
            </>
          )}
          {allTxns.length === 0 && <TxnTable items={[]} emptyText="No transactions tagged to this vehicle yet." />}
        </>
      )}

      {tab === 'value' && (
        <SnapshotTab
          items={values}
          onAdd={addValue}
          onDelete={delValue}
          title="Value Snapshots"
          chartTitle="Value Over Time"
          hint="Record the value on a date — the latest drives depreciation and net worth."
          onEstimate={estimateValue}
          estimating={estimating}
          estimateMsg={estimateMsg}
          estimateLabel="Estimate & Record"
          estimateDisabledReason={aiConfigured === false ? <AiKeyHint action="estimate value" /> : undefined}
        />
      )}

      {tab === 'maintenance' && (
        <MaintenanceTab vehicleId={id} odometer={v.odometer_current} onChanged={() => { loadReadings(); loadVehicle(); loadSummary(); }} />
      )}

      {tab === 'odometer' && (
        <SnapshotTab
          items={readings}
          onAdd={addReading}
          onDelete={delReading}
          title="Odometer Readings"
          chartTitle="Odometer Over Time"
          valueLabel="Odometer"
          addLabel="Add Reading"
          integer
          placeholder="35000"
          format={milesFmt}
          yTickFormat={odoTick}
          chartColor="#5A6F87"
          hint="Record the odometer on a date — the latest reading is the current mileage used everywhere."
          emptyText="No odometer readings yet. Record the mileage on a date — the latest reading becomes the vehicle's current odometer and drives miles-driven and cost-per-mile."
        />
      )}

      {tab === 'insurance' && <EntityInsurance basePath={`/vehicles/${id}`} typeHint="e.g. Auto, Comprehensive, Liability" />}

      {tab === 'documents' && <EntityDocuments basePath={`/vehicles/${id}`} docTypes={VEHICLE_DOC_TYPES} />}

      {tab === 'details' && (
        <>
          <VehicleInfoForm
            vehicle={v}
            isNew={false}
            onSaved={() => { loadVehicle(); loadSummary(); }}
            onDeleted={() => navigate('/vehicles')}
            extraDirty={warrantyDirty || disposeStaged}
            onExtraSave={saveExtras}
            confirmBeforeSave={confirmExtras}
            beforeDocuments={
              <div style={{ marginTop: 16 }}>
                <WarrantyEditor vehicleId={id} rows={wrows} setRow={setWRow} removeRow={removeWRow} addRow={addWRow} />
              </div>
            }
          />

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="section" style={{ margin: 0 }}>Change Ownership</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {disposed
                    ? `No longer owned${v.disposed_at ? ` since ${shortDate(v.disposed_at)}` : ''} — kept for history, excluded from net worth.`
                    : 'Sold, traded, or scrapped it? Mark it as no longer owned to keep its history without counting it in net worth.'}
                </div>
              </div>
              {disposed
                ? <button className="ghost" onClick={restore}>Mark as Owned Again</button>
                : !disposing && <button className="ghost" onClick={() => { setDisposeForm(blankDisposeForm(v)); setDisposing(true); }}>No Longer Owned</button>}
            </div>
            {!disposed && disposing && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
                <VehicleDisposeFields vehicle={v} form={disposeForm} setForm={setDisposeForm} onClose={() => setDisposing(false)} />
              </div>
            )}
          </div>
        </>
      )}

      {addingTxn && lookups && (
        <TxnEditor
          txn={null}
          lookups={lookups}
          purchasers={[]}
          merchants={merchants}
          initialTags={[{ kind: 'vehicle', ref_id: id, name: v.name }]}
          onClose={() => setAddingTxn(false)}
          onSaved={() => { setAddingTxn(false); loadTxns(); loadSummary(); }}
        />
      )}

      {editingTxn && lookups && (
        <TxnEditor
          txn={editingTxn}
          lookups={lookups}
          purchasers={[]}
          merchants={merchants}
          onClose={() => setEditingTxn(null)}
          onSaved={() => { setEditingTxn(null); loadTxns(); loadSummary(); }}
        />
      )}
    </>
  );
}

// Editable string-form warranty row for the in-tab table.
type WRow = { id?: number; coverage: string; provider: string; expiration: string; expires_miles: string; cost: string; cost_in_purchase_price: boolean; transaction_id: string; notes: string };
const toWRow = (w: VehicleWarranty): WRow => ({
  id: w.id, coverage: w.coverage ?? '', provider: w.provider ?? '',
  expiration: w.expiration?.slice(0, 10) ?? '', expires_miles: w.expires_miles?.toString() ?? '',
  cost: w.cost?.toString() ?? '', cost_in_purchase_price: !!w.cost_in_purchase_price, transaction_id: w.transaction_id?.toString() ?? '',
  notes: w.notes ?? '',
});

// Inline table to add / edit / remove a vehicle's warranties.
const blankWRow = (): WRow => ({ coverage: '', provider: '', expiration: '', expires_miles: '', cost: '', cost_in_purchase_price: false, transaction_id: '', notes: '' });
const isBlankWRow = (r: WRow) => !r.coverage && !r.provider && !r.expiration && !r.expires_miles && !r.cost && !r.notes;
// Only the saved warranties — new rows are added explicitly via the "Add warranty" button.
const seedWRows = (ws: VehicleWarranty[]) => ws.map(toWRow);

// Controlled warranty table. Rows + handlers are owned by the parent so the Details
// form's "Save Changes" button persists them; this component just renders/edits.
function WarrantyEditor({ vehicleId, rows, setRow, removeRow, addRow }: {
  vehicleId: number;
  rows: WRow[];
  setRow: (i: number, patch: Partial<WRow>) => void;
  removeRow: (i: number) => void;
  addRow: () => void;
}) {
  // Vehicle-tagged expenses, offered for linking a warranty's cost to its transaction.
  const [cands, setCands] = useState<ExpenseCandidate[]>([]);
  useEffect(() => { api.get<ExpenseCandidate[]>(`/vehicles/${vehicleId}/expense-candidates`).then(setCands).catch(() => {}); }, [vehicleId]);
  const candidateLabel = (c: ExpenseCandidate) => `${shortDate(c.txn_date)} · ${money(c.amount)} · ${c.merchant || c.description || c.account_name || 'transaction'}`;

  return (
    <div className="card">
      <Section title="Warranty" headClassName="section" headStyle={{ margin: '0 0 8px' }}>
      {rows.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 8 }}>
          <table className="ledger">
            <thead><tr><th>Coverage</th><th>Provider</th><th>Expires (Date)</th><th className="r">Expires at (Odometer)</th><th></th></tr></thead>
            <tbody>
              {rows.map((w, i) => {
                const isNewRow = w.id == null;
                const costSource = w.cost_in_purchase_price ? 'purchase' : (w.transaction_id ? `txn:${w.transaction_id}` : '');
                const linkedMissing = !!w.transaction_id && !cands.some((c) => String(c.id) === w.transaction_id);
                // Each warranty spans two rows; tint alternates per warranty so the
                // two-row blocks stay visually distinct (overrides the ledger striping).
                const tint = i % 2 === 1 ? 'var(--surface-alt)' : 'var(--surface)';
                const miniLabel = { display: 'block', fontSize: 11, color: 'var(--muted)', marginBottom: 2, fontWeight: 500 } as const;
                const onPickSource = (val: string) => {
                  if (val === 'purchase') setRow(i, { cost_in_purchase_price: true, transaction_id: '' });
                  else if (val.startsWith('txn:')) {
                    const tid = val.slice(4);
                    const c = cands.find((x) => String(x.id) === tid);
                    setRow(i, { cost_in_purchase_price: false, transaction_id: tid, ...(c ? { cost: String(c.amount) } : {}) });
                  } else setRow(i, { cost_in_purchase_price: false, transaction_id: '' });
                };
                return (
                  <Fragment key={w.id ?? `new-${i}`}>
                    <tr style={{ background: tint }}>
                      <td style={{ borderBottom: 'none' }}><input value={w.coverage} onChange={(e) => setRow(i, { coverage: e.target.value })} placeholder={isNewRow ? 'Powertrain' : ''} /></td>
                      <td style={{ borderBottom: 'none' }}><input value={w.provider} onChange={(e) => setRow(i, { provider: e.target.value })} placeholder={isNewRow ? 'Toyota' : ''} /></td>
                      <td style={{ borderBottom: 'none' }}><input type="date" value={w.expiration} onChange={(e) => setRow(i, { expiration: e.target.value })} /></td>
                      <td style={{ borderBottom: 'none' }}><input className="num-input" inputMode="numeric" value={w.expires_miles} onChange={(e) => setRow(i, { expires_miles: e.target.value })} placeholder={isNewRow ? '35000' : ''} style={{ textAlign: 'right' }} /></td>
                      <td className="r" style={{ borderBottom: 'none' }}><button type="button" className="ghost" style={{ padding: '2px 8px' }} title="Remove" onClick={() => removeRow(i)}>✕</button></td>
                    </tr>
                    <tr style={{ background: tint }}>
                      <td style={{ paddingTop: 0 }}>
                        <span style={miniLabel}>Cost</span>
                        <AmountInput value={w.cost} onChange={(v) => setRow(i, { cost: v })} placeholder={isNewRow ? '0.00' : ''} />
                      </td>
                      <td style={{ paddingTop: 0 }}>
                        <span style={miniLabel}>Cost source</span>
                        <select value={costSource} onChange={(e) => onPickSource(e.target.value)}>
                          <option value="">Not Linked</option>
                          <option value="purchase">In Purchase Price</option>
                          {linkedMissing && <option value={`txn:${w.transaction_id}`}>Transaction #{w.transaction_id}</option>}
                          {cands.length > 0 && (
                            <optgroup label="Link a Transaction">
                              {cands.map((c) => <option key={c.id} value={`txn:${c.id}`}>{candidateLabel(c)}</option>)}
                            </optgroup>
                          )}
                        </select>
                      </td>
                      <td colSpan={3} style={{ paddingTop: 0 }}>
                        <span style={miniLabel}>Notes</span>
                        <input value={w.notes} onChange={(e) => setRow(i, { notes: e.target.value })} placeholder={isNewRow ? 'bumper-to-bumper' : ''} />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="ghost" onClick={addRow}>+ Add Warranty</button>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        “Expires at” is the odometer reading where coverage ends (e.g. bought at 25,000 + a 10,000-mile warranty ⇒ 35,000). Warranty changes save with the form's Save Changes button.
      </div>
      </Section>
    </div>
  );
}

// Maintenance tab: scheduled upcoming items (next oil change, etc.) on top, then
// completed service history (each optionally tied to a transaction). Add/edit via
// a modal.
function MaintenanceTab({ vehicleId, odometer, onChanged }: { vehicleId: number; odometer: number | null; onChanged?: () => void }) {
  const [items, setItems] = useState<Maintenance[]>([]);
  const [editing, setEditing] = useState<{ item: Maintenance | null; status: 'completed' | 'upcoming' } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api.get<Maintenance[]>(`/vehicles/${vehicleId}/maintenance`).then(setItems).catch(() => {});
  useEffect(() => { load(); }, [vehicleId]);

  const upcoming = items.filter((i) => i.status === 'upcoming');
  const history = items.filter((i) => i.status === 'completed')
    .sort((a, b) => ((a.service_date ?? '') < (b.service_date ?? '') ? 1 : -1));

  const del = async (id: number) => {
    if (!confirm('Delete this maintenance item?')) return;
    // Deleting a completed item also removes its linked odometer snapshot server-side.
    try { await api.del(`/vehicles/${vehicleId}/maintenance/${id}`); load(); onChanged?.(); } catch (e: any) { setErr(e.message); }
  };
  const costOf = (m: Maintenance) => (m.transaction_id != null ? m.txn_amount : m.cost);

  // "Due in" indicator for an upcoming item, vs today and the current odometer.
  const dueInfo = (m: Maintenance) => {
    const days = m.due_date ? daysBetween(todayStr(), m.due_date) : null;
    const miles = m.due_odometer != null && odometer != null ? m.due_odometer - odometer : null;
    const overdue = (days != null && days < 0) || (miles != null && miles < 0);
    const parts: string[] = [];
    if (days != null) parts.push(days < 0 ? `${Math.abs(days)}d overdue` : `${days.toLocaleString()}d`);
    if (miles != null) parts.push(miles < 0 ? `${Math.abs(miles).toLocaleString()} mi over` : `${miles.toLocaleString()} mi`);
    return { text: parts.join(' · ') || '—', overdue };
  };

  return (
    <>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px 8px' }}>
          <div className="section" style={{ margin: 0 }}>Upcoming Maintenance</div>
          <button style={{ minWidth: 150 }} onClick={() => setEditing({ item: null, status: 'upcoming' })}>Add Upcoming</button>
        </div>
        {upcoming.length === 0 ? (
          <div className="empty" style={{ padding: '0 14px 14px' }}>Nothing scheduled. Add the next oil change, tire rotation, etc.</div>
        ) : (
          <table className="ledger">
            <thead><tr><th>Item</th><th>Due (Date)</th><th className="r">Due at (Odometer)</th><th className="r">Due In</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {upcoming.map((m) => {
                const d = dueInfo(m);
                return (
                  <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => setEditing({ item: m, status: m.status })}>
                    <td>{m.item}{m.doc_count ? <span className="tag" style={{ marginLeft: 6, textTransform: 'none' }}>{m.doc_count} doc{m.doc_count === 1 ? '' : 's'}</span> : ''}</td>
                    <td className="num">{m.due_date ? shortDate(m.due_date) : '—'}</td>
                    <td className="r num">{m.due_odometer != null ? `${m.due_odometer.toLocaleString()} mi` : '—'}</td>
                    <td className={`r num ${d.overdue ? 'debit' : ''}`}>{d.text}</td>
                    <td className="muted">{m.notes || '—'}</td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      <button className="ghost" style={{ padding: '2px 8px' }} title="Delete" onClick={(e) => { e.stopPropagation(); del(m.id); }}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px 8px' }}>
          <div className="section" style={{ margin: 0 }}>Service History</div>
          <button style={{ minWidth: 150 }} onClick={() => setEditing({ item: null, status: 'completed' })}>Add Completed</button>
        </div>
        {history.length === 0 ? (
          <div className="empty" style={{ padding: '0 14px 14px' }}>No maintenance recorded yet.</div>
        ) : (
          <table className="ledger">
            <thead><tr><th>Date</th><th className="r">Odometer</th><th>Item</th><th>Vendor</th><th className="r">Cost</th><th></th></tr></thead>
            <tbody>
              {history.map((m) => (
                <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => setEditing({ item: m, status: m.status })}>
                  <td className="num">{m.service_date ? shortDate(m.service_date) : '—'}</td>
                  <td className="r num">{m.odometer != null ? `${m.odometer.toLocaleString()} mi` : '—'}</td>
                  <td>{m.item}{m.notes ? <span className="muted" style={{ fontSize: 12 }}> · {m.notes}</span> : ''}{m.doc_count ? <span className="tag" style={{ marginLeft: 6, textTransform: 'none' }}>{m.doc_count} doc{m.doc_count === 1 ? '' : 's'}</span> : ''}</td>
                  <td className="muted">{m.vendor || '—'}</td>
                  <td className="r money num">
                    {costOf(m) != null ? money(costOf(m)) : '—'}
                    {m.transaction_id != null && <span className="tag" style={{ marginLeft: 6, textTransform: 'none' }}>Txn</span>}
                  </td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="ghost" style={{ padding: '2px 8px' }} title="Delete" onClick={(e) => { e.stopPropagation(); del(m.id); }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <MaintenanceEditor
          vehicleId={vehicleId}
          item={editing.item}
          defaultStatus={editing.status}
          odometer={odometer}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onChanged?.(); }}
        />
      )}
    </>
  );
}

function MaintenanceEditor({ vehicleId, item, defaultStatus, odometer, onClose, onSaved }: {
  vehicleId: number; item: Maintenance | null; defaultStatus: 'completed' | 'upcoming'; odometer: number | null; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    item: item?.item ?? '',
    status: (item?.status ?? defaultStatus) as 'completed' | 'upcoming',
    service_date: item?.service_date?.slice(0, 10) ?? (item ? '' : (defaultStatus === 'completed' ? todayStr() : '')),
    odometer: item?.odometer?.toString() ?? '',
    cost: item?.cost?.toString() ?? '',
    transaction_id: item?.transaction_id?.toString() ?? '',
    due_date: item?.due_date?.slice(0, 10) ?? '',
    due_odometer: item?.due_odometer?.toString() ?? '',
    vendor: item?.vendor ?? '',
    notes: item?.notes ?? '',
  });
  const [cands, setCands] = useState<ExpenseCandidate[]>([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const num = (s: string) => (s === '' ? null : Number(s));
  const completed = f.status === 'completed';
  useEffect(() => { api.get<ExpenseCandidate[]>(`/vehicles/${vehicleId}/expense-candidates`).then(setCands).catch(() => {}); }, [vehicleId]);

  // Documents (receipts / service invoices) attached to this maintenance record.
  const [docs, setDocs] = useState<VehicleDoc[]>([]);
  const loadDocs = () => { if (item) api.get<VehicleDoc[]>(`/vehicles/${vehicleId}/maintenance/${item.id}/documents`).then(setDocs).catch(() => {}); };
  useEffect(() => { loadDocs(); }, [item?.id]);
  const onPickDoc = async (file: File | undefined) => {
    if (!file || !item) return;
    setErr('');
    try {
      const { data, mime, name } = await fileToBase64(file);
      // Default the name to "<item> · <date>"; the server tags it type 'maintenance'.
      const date = f.service_date || f.due_date || '';
      const defaultName = [f.item.trim(), date ? shortDate(date) : null].filter(Boolean).join(' · ');
      await api.post(`/vehicles/${vehicleId}/maintenance/${item.id}/documents`, { file: data, file_mime: mime, file_name: name, name: defaultName || name });
      loadDocs();
    } catch (e: any) { setErr(e.message); }
  };
  const delDoc = async (docId: number) => {
    try { await api.del(`/vehicles/${vehicleId}/documents/${docId}`); loadDocs(); } catch (e: any) { setErr(e.message); }
  };

  // Switch an upcoming item to completed, pre-filling today's date + current
  // odometer so the user can confirm/adjust the completion details before saving.
  const markComplete = () => {
    setF((cur) => ({
      ...cur,
      status: 'completed',
      service_date: cur.service_date || todayStr(),
      odometer: cur.odometer || (odometer != null ? String(odometer) : ''),
    }));
  };

  const save = async () => {
    if (!f.item.trim()) { setErr('Describe the maintenance item.'); return; }
    setSaving(true); setErr('');
    try {
      const body = {
        item: f.item, status: f.status,
        service_date: completed ? (f.service_date || null) : null,
        odometer: completed ? num(f.odometer) : null,
        cost: completed ? num(f.cost) : null,
        transaction_id: completed ? num(f.transaction_id) : null,
        due_date: !completed ? (f.due_date || null) : null,
        due_odometer: !completed ? num(f.due_odometer) : null,
        vendor: f.vendor || null, notes: f.notes || null,
      };
      if (item) await api.put(`/vehicles/${vehicleId}/maintenance/${item.id}`, body);
      else await api.post(`/vehicles/${vehicleId}/maintenance`, body);
      onSaved();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  const candidateLabel = (c: ExpenseCandidate) =>
    `${shortDate(c.txn_date)} · ${money(c.amount)} · ${c.merchant || c.description || c.account_name || 'transaction'}`;

  return (
    <Modal title={item ? `Edit · ${item.item}` : 'Add Maintenance'} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <Field label="Item"><input value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="e.g. Oil change, tire rotation, brakes" /></Field>
      <Field label="Type">
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'completed' | 'upcoming' })}>
          <option value="completed">Completed (History)</option>
          <option value="upcoming">Upcoming (Scheduled)</option>
        </select>
      </Field>
      {item && f.status === 'upcoming' && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button type="button" className="brass" onClick={markComplete}>Mark Complete</button>
          <span className="muted" style={{ fontSize: 12, marginLeft: 10, alignSelf: 'center' }}>Records it as done today at the current odometer — adjust the details below, then Save.</span>
        </div>
      )}

      {completed ? (
        <>
          <div className="grid grid-2">
            <Field label="Service Date"><input type="date" value={f.service_date} onChange={(e) => setF({ ...f, service_date: e.target.value })} /></Field>
            <Field label="Odometer"><input className="num-input" inputMode="numeric" value={f.odometer} onChange={(e) => setF({ ...f, odometer: e.target.value })} placeholder="e.g. 38000" style={{ textAlign: 'right' }} /></Field>
          </div>
          <Field label="Vendor"><input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} placeholder="e.g. Jiffy Lube" /></Field>
          <Field label="Linked Transaction (Optional)">
            <select value={f.transaction_id} onChange={(e) => {
              const tid = e.target.value;
              // Pull the vendor from the linked transaction's merchant (when blank).
              const c = cands.find((x) => String(x.id) === tid);
              setF({ ...f, transaction_id: tid, vendor: (c?.merchant && !f.vendor.trim()) ? c.merchant : f.vendor });
            }}>
              <option value="">None — enter a cost below</option>
              {cands.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
            </select>
          </Field>
          {!f.transaction_id && (
            <Field label="Cost (Optional)"><AmountInput value={f.cost} onChange={(v) => setF({ ...f, cost: v })} placeholder="0.00" /></Field>
          )}
        </>
      ) : (
        <div className="grid grid-2">
          <Field label="Due Date"><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
          <Field label="Due at (Odometer)"><input className="num-input" inputMode="numeric" value={f.due_odometer} onChange={(e) => setF({ ...f, due_odometer: e.target.value })} placeholder="e.g. 40000" style={{ textAlign: 'right' }} /></Field>
        </div>
      )}

      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="optional" /></Field>

      <Field label="Documents">
        {item ? (
          <>
            <label className="ghost" style={{ cursor: 'pointer', display: 'inline-block', padding: '9px 16px', border: '1px solid var(--hairline-strong)', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 600 }}>
              Upload Document
              <input type="file" accept="image/*,application/pdf,.pdf,.doc,.docx,.txt" style={{ display: 'none' }} onChange={(e) => onPickDoc(e.target.files?.[0])} />
            </label>
            {docs.length === 0 ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No documents yet — attach the receipt or service invoice.</div>
            ) : docs.map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
                <a href={`/api/vehicles/${vehicleId}/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.file_name || d.name || 'document'}</a>
                <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="muted num" style={{ fontSize: 12 }}>{shortDate(d.created_at)}</span>
                  <button type="button" className="ghost" style={{ padding: '2px 8px' }} title="Delete" onClick={() => delDoc(d.id)}>✕</button>
                </span>
              </div>
            ))}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>Save this maintenance item first, then reopen it to attach receipts or invoices.</div>
        )}
      </Field>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : item ? 'Save Changes' : 'Add'}</button>
      </div>
    </Modal>
  );
}

// Editable core vehicle info, rendered inline on the detail page (no popup). Used
// both for "Add Vehicle" (isNew) and the Details tab of an existing vehicle. A
// Save button becomes enabled once something changes. Sub-details (odometer,
// maintenance, warranty, value snapshots) live in their own tabs / popups.
function VehicleInfoForm({ vehicle, isNew, onSaved, onDeleted, beforeDocuments, extraDirty, onExtraSave, confirmBeforeSave }: {
  vehicle: Vehicle | null; isNew: boolean; onSaved: (v: Vehicle) => void; onDeleted?: () => void;
  beforeDocuments?: ReactNode; extraDirty?: boolean; onExtraSave?: () => Promise<void>; confirmBeforeSave?: () => boolean;
}) {
  const seedOf = (v: Vehicle | null) => ({
    name: v?.name ?? '', make: v?.make ?? '', model: v?.model ?? '', trim: v?.trim ?? '', year: v?.year?.toString() ?? '',
    vin: v?.vin ?? '', purchase_date: v?.purchase_date?.slice(0, 10) ?? '', purchase_price: v?.purchase_price?.toString() ?? '',
    current_value: v?.current_value?.toString() ?? '', odometer_start: v?.odometer_start?.toString() ?? '', odometer_current: v?.odometer_current?.toString() ?? '',
    vehicle_type: v?.vehicle_type ?? '', fuel_type: v?.fuel_type ?? '', engine_type: v?.engine_type ?? '',
    transmission: v?.transmission ?? '', drivetrain: v?.drivetrain ?? '', exterior_color: v?.exterior_color ?? '', license_plate: v?.license_plate ?? '',
    notes: v?.notes ?? '',
  });
  const [f, setF] = useState(() => seedOf(vehicle));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seedOf(vehicle)));
  // Re-seed when the saved vehicle changes (e.g. after a save reloads it).
  useEffect(() => { const s = seedOf(vehicle); setF(s); setSavedJson(JSON.stringify(s)); }, [vehicle?.id]);
  const fDirty = JSON.stringify(f) !== savedJson;

  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [decodeMsg, setDecodeMsg] = useState('');
  const [estimating, setEstimating] = useState(false);
  const [estimateMsg, setEstimateMsg] = useState('');
  const aiConfigured = useAiConfigured();
  const navigate = useNavigate();
  // Car loan, managed as a liability account (mirrors a property's mortgage).
  const linkedLoanOf = (v: Vehicle | null) => (v?.loan_account_id != null
    ? { id: v.loan_account_id, name: v.loan_account_name ?? 'Loan', balance: Number(v.loan_account_balance ?? 0) } : null);
  const [linkedLoan, setLinkedLoan] = useState(() => linkedLoanOf(vehicle));
  const [hasLoan, setHasLoan] = useState(() => vehicle?.loan_account_id != null);
  const [loanOpening, setLoanOpening] = useState('');
  // 'loan' accounts available to link — not already tied to a vehicle or property.
  const [loanAccounts, setLoanAccounts] = useState<{ id: number; name: string; type?: string; posted_balance?: number }[]>([]);
  const [linkAccountId, setLinkAccountId] = useState('');
  const loadLoanAccounts = () => api.get<typeof loanAccounts>('/vehicles/loan-accounts').then(setLoanAccounts).catch(() => {});
  useEffect(() => {
    setHasLoan(vehicle?.loan_account_id != null); setLoanOpening(''); setLinkAccountId('');
    loadLoanAccounts();
  }, [vehicle?.id]);
  // Keep the linked-loan summary in sync with the latest balance from the server.
  useEffect(() => { setLinkedLoan(linkedLoanOf(vehicle)); }, [vehicle?.id, vehicle?.loan_account_id, vehicle?.loan_account_name, vehicle?.loan_account_balance]);

  const num = (s: string) => (s === '' ? null : Number(s));

  const newLoanAmountValid = num(loanOpening) != null && Number(loanOpening) > 0;
  // A loan choice is "staged" (pending Save) when the vehicle isn't linked yet but
  // the user has picked an account or entered a new balance. Save applies it.
  const loanStaged = !linkedLoan && hasLoan && (!!linkAccountId || newLoanAmountValid);
  const dirty = fDirty || loanStaged || !!extraDirty;

  const unlinkLoan = async () => {
    if (!vehicle || !confirm('Unlink this loan account? The account stays in Accounts; you can delete it there.')) return;
    try { await api.del(`/vehicles/${vehicle.id}/loan-account`); setLinkedLoan(null); setLinkAccountId(''); setLoanOpening(''); loadLoanAccounts(); onSaved(vehicle); } catch (e: any) { setErr(e.message); }
  };
  // Apply a staged loan to a (just-saved or existing) vehicle: link a chosen account
  // or create+link a new one. Called from save().
  const applyLoan = async (vehicleId: number) => {
    if (linkedLoan || !hasLoan || !(linkAccountId || newLoanAmountValid)) return;
    const body = linkAccountId ? { account_id: Number(linkAccountId) } : { opening_balance: num(loanOpening) };
    await api.post(`/vehicles/${vehicleId}/loan-account`, body);
  };

  const decodeVin = async () => {
    const vin = f.vin.trim();
    if (!vin) { setErr('Enter a VIN to look up.'); return; }
    setErr(''); setDecodeMsg(''); setDecoding(true);
    try {
      const d = await api.get<{ vin: string; make: string | null; model: string | null; year: number | null; name: string | null; trim: string | null; vehicle_type: string | null; fuel_type: string | null; engine_type: string | null; transmission: string | null; drivetrain: string | null }>(`/vehicles/decode/${encodeURIComponent(vin)}`);
      setF((cur) => ({
        ...cur, vin: d.vin,
        make: d.make ?? cur.make, model: d.model ?? cur.model, year: d.year != null ? String(d.year) : cur.year,
        name: cur.name.trim() ? cur.name : (d.name ?? cur.name),
        trim: d.trim ?? cur.trim, vehicle_type: d.vehicle_type ?? cur.vehicle_type, fuel_type: d.fuel_type ?? cur.fuel_type,
        engine_type: d.engine_type ?? cur.engine_type, transmission: d.transmission ?? cur.transmission, drivetrain: d.drivetrain ?? cur.drivetrain,
      }));
      setDecodeMsg([d.year, d.make, d.model, d.trim].filter(Boolean).join(' ') || 'Decoded.');
    } catch (e: any) { setErr(e.message); }
    finally { setDecoding(false); }
  };

  // For a new vehicle, the estimate fills the value field; existing vehicles record
  // value snapshots on the Value tab instead.
  const estimateValue = async () => {
    setErr(''); setEstimateMsg(''); setEstimating(true);
    try {
      const r = await api.post<{ value: number; low: number | null; high: number | null; rationale: string | null }>('/vehicles/estimate-value', {
        make: f.make || null, model: f.model || null, year: num(f.year),
        odometer_current: num(f.odometer_current), purchase_price: num(f.purchase_price), purchase_date: f.purchase_date || null,
      });
      setF((cur) => ({ ...cur, current_value: String(r.value) }));
      const range = r.low != null && r.high != null ? ` (range ${money(r.low)}–${money(r.high)})` : '';
      setEstimateMsg(`Estimated ${money(r.value)}${range}.${r.rationale ? ' ' + r.rationale : ''}`);
    } catch (e: any) { setErr(e.message); }
    finally { setEstimating(false); }
  };

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    // A brand-new loan needs a real balance; linking an existing (possibly paid-off) account is fine.
    if (!linkedLoan && hasLoan && !linkAccountId && !newLoanAmountValid) {
      setErr('Enter the amount owed on the loan (greater than $0), or link an existing account.'); return;
    }
    if (confirmBeforeSave && !confirmBeforeSave()) return;
    setSaving(true); setErr('');
    const body = {
      name: f.name, make: f.make || null, model: f.model || null, trim: f.trim || null, year: num(f.year), vin: f.vin || null,
      purchase_date: f.purchase_date || null, purchase_price: num(f.purchase_price),
      // Existing vehicles' value is owned by snapshots; only seed it on create.
      current_value: isNew ? num(f.current_value) : null,
      odometer_start: num(f.odometer_start), odometer_current: num(f.odometer_current),
      vehicle_type: f.vehicle_type || null, fuel_type: f.fuel_type || null, engine_type: f.engine_type || null,
      transmission: f.transmission || null, drivetrain: f.drivetrain || null, exterior_color: f.exterior_color || null, license_plate: f.license_plate || null,
      notes: f.notes || null,
    };
    try {
      const v = isNew ? await api.post<Vehicle>('/vehicles', body) : await api.put<Vehicle>(`/vehicles/${vehicle!.id}`, body);
      await applyLoan(v.id);
      if (onExtraSave) await onExtraSave();
      setSavedJson(JSON.stringify(f));
      loadLoanAccounts();
      onSaved(v);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!vehicle || !confirm(`Delete vehicle "${vehicle.name}"? This can't be undone — consider "Mark as No Longer Owned" to keep its history.`)) return;
    try { await api.del(`/vehicles/${vehicle.id}`); onDeleted?.(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>{isNew ? 'New Vehicle' : 'Vehicle Details'}</div>
        <div className="btn-row">
          {!isNew && onDeleted && <button className="danger" onClick={remove}>Delete</button>}
          <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : isNew ? 'Add Vehicle' : 'Save Changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <Section title="Identity & Specifications" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <Field label="Name (Label)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Daily driver" /></Field>
          <Field label="VIN">
            <div className="row" style={{ gap: 8 }}>
              <input value={f.vin} onChange={(e) => { setF({ ...f, vin: e.target.value }); setDecodeMsg(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); decodeVin(); } }}
                placeholder="Enter VIN to auto-fill make, model, trim & specs" style={{ flex: 1 }} />
              <button type="button" className="ghost" onClick={decodeVin} disabled={decoding || !f.vin.trim()}>{decoding ? 'Looking up…' : 'Look Up'}</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {decodeMsg ? `Decoded: ${decodeMsg}` : 'Tip: enter the VIN and tap Look Up to auto-fill the make, model, trim, and specifications below.'}
            </div>
          </Field>
          <div className="grid grid-4">
            <Field label="Year"><input className="num-input" inputMode="numeric" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} /></Field>
            <Field label="Make"><input value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} /></Field>
            <Field label="Model"><input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
            <Field label="Trim"><input value={f.trim} onChange={(e) => setF({ ...f, trim: e.target.value })} placeholder="e.g. Rubicon, Limited" /></Field>
          </div>

          <EditorSection title="Specifications" />
          <div className="grid grid-3">
            <Field label="Vehicle Type"><input value={f.vehicle_type} onChange={(e) => setF({ ...f, vehicle_type: e.target.value })} placeholder="e.g. SUV, Sedan, Truck" /></Field>
            <Field label="Fuel Type"><input value={f.fuel_type} onChange={(e) => setF({ ...f, fuel_type: e.target.value })} placeholder="e.g. Gasoline, Electric" /></Field>
            <Field label="Engine Type"><input value={f.engine_type} onChange={(e) => setF({ ...f, engine_type: e.target.value })} placeholder="e.g. 3.6L 6-cyl" /></Field>
            <Field label="Transmission"><input value={f.transmission} onChange={(e) => setF({ ...f, transmission: e.target.value })} placeholder="e.g. 8-Speed Automatic" /></Field>
            <Field label="Drivetrain"><input value={f.drivetrain} onChange={(e) => setF({ ...f, drivetrain: e.target.value })} placeholder="e.g. 4WD, FWD, AWD" /></Field>
            <Field label="Exterior Color"><input value={f.exterior_color} onChange={(e) => setF({ ...f, exterior_color: e.target.value })} placeholder="e.g. Black" /></Field>
            <Field label="License Plate"><input value={f.license_plate} onChange={(e) => setF({ ...f, license_plate: e.target.value })} placeholder="e.g. ABC 1234" /></Field>
          </div>

          <EditorSection title="Notes" />
          <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="Ownership & Financing" headStyle={{ marginTop: 6, marginBottom: 6 }}>
        <div className="grid grid-2">
          <Field label="Purchase Date"><input type="date" value={f.purchase_date} onChange={(e) => setF({ ...f, purchase_date: e.target.value })} /></Field>
          <Field label="Purchase Price"><AmountInput value={f.purchase_price} onChange={(v) => setF({ ...f, purchase_price: v })} /></Field>
        </div>
        <div className="grid grid-2">
          <Field label="Odometer Start"><input className="num-input" inputMode="numeric" value={f.odometer_start} onChange={(e) => setF({ ...f, odometer_start: e.target.value })} /></Field>
          <Field label="Odometer Current"><input className="num-input" inputMode="numeric" value={f.odometer_current} onChange={(e) => setF({ ...f, odometer_current: e.target.value })} /></Field>
        </div>

        <EditorSection title="Financing" />
        {linkedLoan ? (
          <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            {linkedLoan.balance <= 0.005
              ? <span className="tag" style={{ borderColor: 'var(--income)', color: 'var(--income)' }}>Paid off</span>
              : <span className="tag">Managed as account</span>}
            <span className="muted" style={{ fontSize: 13 }}>{linkedLoan.name} · {linkedLoan.balance <= 0.005 ? '$0.00 owed' : `${money(linkedLoan.balance)} owed`}</span>
            <button type="button" className="ghost" style={{ padding: '3px 10px' }} onClick={() => navigate('/accounts')}>Open in Accounts</button>
            <button type="button" className="ghost" style={{ padding: '3px 10px' }} onClick={unlinkLoan}>Unlink</button>
          </div>
        ) : (
          <>
            <label className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={hasLoan} onChange={(e) => setHasLoan(e.target.checked)} />
              <span>This vehicle has a loan (money is owed on it)</span>
            </label>
            {!hasLoan ? (
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Owned outright — no loan.</div>
            ) : (
              <>
                {loanAccounts.length > 0 && (
                  <Field label="Link an Existing Loan Account">
                    <select value={linkAccountId} onChange={(e) => setLinkAccountId(e.target.value)}>
                      <option value="">Choose an account…</option>
                      {loanAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} · {money(a.posted_balance ?? 0)} owed</option>
                      ))}
                    </select>
                  </Field>
                )}
                {!linkAccountId && (
                  <>
                    {loanAccounts.length > 0 && <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>— or create a new one —</div>}
                    <Field label="Amount Owed"><AmountInput value={loanOpening} onChange={(v) => setLoanOpening(v)} placeholder="0.00" /></Field>
                  </>
                )}
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  {linkAccountId
                    ? `This account will be linked when you ${isNew ? 'save the vehicle' : 'save changes'}.`
                    : `A new loan account will be created and linked when you ${isNew ? 'save the vehicle' : 'save changes'}. Pay it down in Accounts and it shows Paid off at $0.`}
                </div>
              </>
            )}
          </>
        )}
        </Section>

        {isNew && (
          <>
            <EditorSection title="Value" />
            <Field label="Current Value">
              <div className="row" style={{ gap: 8 }}>
                <AmountInput value={f.current_value} onChange={(v) => { setF({ ...f, current_value: v }); setEstimateMsg(''); }} placeholder="Enter manually or estimate" style={{ flex: 1 }} />
                <button type="button" className="brass" onClick={estimateValue} disabled={estimating || aiConfigured === false}>{estimating ? 'Estimating…' : 'Estimate'}</button>
              </div>
              {aiConfigured === false && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><AiKeyHint action="estimate value" /></div>}
              {estimateMsg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{estimateMsg}</div>}
            </Field>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>After saving, record value over time on the Value tab.</div>
          </>
        )}
      </div>

      {!isNew && beforeDocuments}
    </>
  );
}
