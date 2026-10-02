import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money, shortDate, todayStr, parseLocalDate, propertyTypeLabel, PROPERTY_TYPES, PROPERTY_DISPOSAL_TYPES, propertyDisposalTypeLabel } from '../api';
import { AiOutput, BackLink, Field, AmountInput, EditorSection, Modal, Loading } from '../components/ui';
import { type SnapItem } from '../components/SnapshotSection';
import { SnapshotTab } from '../components/SnapshotTab';
import { PropertyAutoValue } from './PropertyAutoValue';
import { EntityDocuments } from '../components/EntityDocuments';
import { EntityInsurance } from '../components/EntityInsurance';
import { TxnEditor } from './transactions/TxnEditor';
import { TxnTable } from './transactions/TxnTable';
import { Pager } from './transactions/common';
import { PAGE_SIZE, type Lookups, type Txn, type TxnPage } from './transactions/helpers';
import { addressLine, mortgageOf, equityOf, isDisposedProp, PROPERTY_DOC_TYPES, type Property, type PropertyDoc, type Summary } from './Properties';

type Tab = 'overview' | 'transactions' | 'snapshots' | 'maintenance' | 'rental' | 'insurance' | 'documents' | 'details';
// `rental` only appears for rental properties (see visibleTabs below).
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'snapshots', label: 'Value' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'rental', label: 'Rental' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'documents', label: 'Documents' },
  { key: 'details', label: 'Details' },
];

interface Maintenance {
  id: number; item: string; status: 'completed' | 'upcoming';
  service_date: string | null; cost: number | null; transaction_id: number | null; due_date: string | null;
  vendor: string | null; notes: string | null;
  txn_date: string | null; txn_amount: number | null; txn_merchant: string | null;
}
interface ExpenseCandidate { id: number; txn_date: string; amount: number; merchant: string | null; description: string | null; account_name: string | null }


function FactList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="detail-list">
      {items.map((f, i) => (<div key={i} className="detail-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>))}
    </dl>
  );
}

// A card's main heading + its content (matches the vehicle Details layout).
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

export default function PropertyDetail() {
  const { propertyId } = useParams();
  const isNew = propertyId === 'new';
  const id = Number(propertyId);
  const navigate = useNavigate();
  const [property, setProperty] = useState<Property | null>(null);
  const [snaps, setSnaps] = useState<SnapItem[]>([]);
  const [txns, setTxns] = useState<TxnPage | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [docs, setDocs] = useState<PropertyDoc[]>([]);
  const [analysis, setAnalysis] = useState('');
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [err, setErr] = useState('');
  const [estimating, setEstimating] = useState(false);
  const [estimateMsg, setEstimateMsg] = useState('');
  const [addingTxn, setAddingTxn] = useState(false);
  const [editingTxn, setEditingTxn] = useState<Txn | null>(null);
  const [disposing, setDisposing] = useState(false);
  const [disposeForm, setDisposeForm] = useState({ disposal_type: 'sold', disposed_at: todayStr(), disposal_amount: '', disposal_note: '' });
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [merchants, setMerchants] = useState<string[]>([]);
  // Live "is a rental" flag so the Rental tab can appear before the toggle is saved.
  const [rentalLive, setRentalLive] = useState(false);
  // Transactions tab: server-side paginated (PAGE_SIZE per page), independent groups.
  const [pendingPage, setPendingPage] = useState(0);
  const [postedPage, setPostedPage] = useState(0);

  const loadProperty = () => api.get<Property[]>('/properties')
    .then((all) => { const p = all.find((x) => x.id === id) ?? null; setProperty(p); if (!p) setErr('Property not found.'); })
    .catch((e) => setErr(e.message));
  const loadSnaps = () => api.get<SnapItem[]>(`/properties/${id}/values`).then(setSnaps).catch(() => {});
  const loadTxns = () => api.get<TxnPage>(
    `/transactions?property_id=${id}&limit=${PAGE_SIZE}&pendingOffset=${pendingPage * PAGE_SIZE}&postedOffset=${postedPage * PAGE_SIZE}`,
  ).then(setTxns).catch(() => {});
  const loadSummary = () => api.get<Summary>(`/properties/${id}/summary`).then(setSummary).catch(() => {});
  const loadDocs = () => api.get<PropertyDoc[]>(`/properties/${id}/documents`).then(setDocs).catch(() => {});

  useEffect(() => {
    if (isNew) return; // "new" mode renders an empty info form; nothing to load
    if (!Number.isFinite(id)) { setErr('Invalid property.'); return; }
    loadProperty(); loadSnaps(); loadSummary(); loadDocs();
  }, [id]);

  // Reload the current transaction page when the property or either page changes.
  useEffect(() => { if (!isNew && Number.isFinite(id)) loadTxns(); }, [id, pendingPage, postedPage]);

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

  // Sync the live rental flag whenever the saved property's value changes (load/save).
  useEffect(() => { if (property) setRentalLive(property.is_rental); }, [property?.id, property?.is_rental]);

  // If a property is no longer flagged a rental while the Rental tab is open, fall back.
  useEffect(() => {
    if (tab === 'rental' && !rentalLive) setTab('details');
  }, [rentalLive, tab]);

  const runAnalysis = async () => {
    setRunning(true); setErr('');
    try {
      const res = await api.post<{ summary: Summary; result: string }>(`/analysis/property/${id}/cost-of-ownership`);
      setAnalysis(res.result);
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  // "Add property" — render the info form directly on the page (no popup). Saving
  // creates the property and navigates to its full detail page.
  if (isNew) {
    return (
      <>
        <BackLink to="/properties" label="Back to Properties" />
        <div className="page-head" style={{ marginTop: 10 }}>
          <div>
            <h1 className="title">Add Property</h1>
            <p className="subtitle">Enter the details and Save. You can record value snapshots, set up a mortgage account, and attach documents after saving.</p>
          </div>
        </div>
        <PropertyInfoForm property={null} isNew section="all" onSaved={(np) => navigate(`/properties/${np.id}`)} />
      </>
    );
  }

  if (err && !property) {
    return (<><BackLink to="/properties" label="Back to Properties" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>);
  }
  if (!property) return <Loading />;

  const p = property;
  const subtitle = [propertyTypeLabel(p.property_type), addressLine(p)].filter(Boolean).join(' · ');
  const mortgage = mortgageOf(p);
  const equity = equityOf(p);

  // Pending transactions are surfaced first (newest-first within each group),
  // then posted — mirroring the Transactions page. Sorting purely by date would
  // let a pending item sink below newer posted rows and drop out of the 8-item
  // "Recent" list, making it look like it's missing.
  const byDateDesc = (x: Txn, y: Txn) => (x.txn_date < y.txn_date ? 1 : -1);
  const pendingTxns = (txns?.pending ?? []).slice().sort(byDateDesc);
  const postedTxns = (txns?.posted ?? []).slice().sort(byDateDesc);
  const allTxns = [...pendingTxns, ...postedTxns];
  // Transactions tab: server totals drive the pager (each group paged separately).
  const pendingTotal = txns?.pendingTotal ?? 0;
  const postedTotal = txns?.total ?? 0;
  const pendingPageCount = Math.max(1, Math.ceil(pendingTotal / PAGE_SIZE));
  const postedPageCount = Math.max(1, Math.ceil(postedTotal / PAGE_SIZE));

  // Value over time for the Value tab chart: seed with the purchase price at the
  // purchase date, include value snapshots, then end at the current value today —
  // so the chart reads purchase → now even with a single recorded snapshot.
  const today = todayStr();
  const ascSnaps = [...snaps].sort((x, y) => (x.as_of < y.as_of ? -1 : 1));
  const isoDaysAgo = (d: string, n: number) => {
    const dt = parseLocalDate(d); dt.setDate(dt.getDate() - n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const chartData: { as_of: string; value: number }[] = [];
  if (p.purchase_price != null) {
    let purchaseDate = p.purchase_date?.slice(0, 10) || ascSnaps[0]?.as_of || today;
    if (purchaseDate >= today) purchaseDate = isoDaysAgo(today, 1);
    chartData.push({ as_of: purchaseDate, value: Number(p.purchase_price) });
  }
  for (const s of ascSnaps) chartData.push({ as_of: s.as_of, value: Number(s.value) });
  if (p.current_value != null) {
    const curVal = Number(p.current_value);
    const lastPt = chartData[chartData.length - 1];
    if (!lastPt || lastPt.as_of !== today) chartData.push({ as_of: today, value: curVal });
    else lastPt.value = curVal;
  }

  // Overview facts — only push values that exist.
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Equity', value: <span className={equity < 0 ? 'debit' : 'credit'}>{money(equity)}</span> },
    { label: 'Mortgage Owed', value: p.mortgage_account_id != null && mortgage <= 0.005 ? 'Paid off' : <span className="debit">{money(mortgage)}</span> },
  ];
  if (p.purchase_price != null) facts.push({ label: 'Purchase Price', value: `${money(p.purchase_price)}${p.purchase_date ? ` · ${shortDate(p.purchase_date)}` : ''}` });
  if (p.current_value != null && p.purchase_price != null) facts.push({ label: 'Appreciation', value: money(p.current_value - p.purchase_price) });
  if (p.is_rental && p.rental_income != null) facts.push({ label: 'Rental Income', value: `${money(p.rental_income)}/mo` });
  if (p.is_rental && p.tenant_name) facts.push({ label: 'Tenant', value: p.tenant_name });
  if (p.is_rental && p.lease_end) facts.push({ label: 'Lease Ends', value: shortDate(p.lease_end) });
  if (p.property_tax_annual != null) facts.push({ label: 'Property Tax', value: `${money(p.property_tax_annual)}/yr` });
  if (p.hoa_dues != null) facts.push({ label: 'HOA Dues', value: `${money(p.hoa_dues)}${p.hoa_cycle ? `/${({ monthly: 'mo', quarterly: 'qtr', semiannual: '6mo', annual: 'yr' } as Record<string, string>)[p.hoa_cycle] ?? 'mo'}` : ''}` });
  if (p.txn_count > 0) facts.push({ label: 'Tagged Spending', value: `${money(p.total_spent)} · ${p.txn_count} txn` });

  const addSnap = async (as_of: string, value: number, source: 'manual' | 'rentcast' | 'ai' = 'manual') => {
    await api.post(`/properties/${id}/values`, { as_of, value, source });
    loadSnaps(); loadProperty(); loadSummary();
  };
  const delSnap = async (snapId: number) => {
    try { await api.del(`/properties/${id}/values/${snapId}`); loadSnaps(); loadProperty(); loadSummary(); } catch (e: any) { setErr(e.message); }
  };
  // Estimate the current value and record it as today's snapshot (latest = current value).
  const estimateValue = async () => {
    if (!property) return;
    setErr(''); setEstimateMsg(''); setEstimating(true);
    try {
      const est = await api.post<{ value: number; low: number | null; high: number | null; rationale: string | null; source?: string }>('/properties/estimate-value', {
        property_type: property.property_type, address: property.address, city: property.city, state: property.state, zip: property.zip,
        square_feet: property.square_feet, lot_size_acres: property.lot_size_acres, year_built: property.year_built,
        purchase_price: property.purchase_price, purchase_date: property.purchase_date,
      });
      await addSnap(todayStr(), est.value, est.source === 'rentcast' ? 'rentcast' : 'ai');
      const range = est.low != null && est.high != null ? ` (range ${money(est.low)}–${money(est.high)})` : '';
      setEstimateMsg(`Estimated ${money(est.value)}${range}${est.source === 'rentcast' ? ' (RentCast)' : ' (AI estimate)'}.${est.rationale ? ' ' + est.rationale : ''}`);
    } catch (e: any) { setErr(e.message); }
    finally { setEstimating(false); }
  };

  // Ownership change (sold / transferred / …) — preserves history, drops out of net worth.
  const disposed = !!property && isDisposedProp(property);
  const startDispose = () => {
    setDisposeForm({
      disposal_type: property?.disposal_type ?? 'sold',
      disposed_at: property?.disposed_at?.slice(0, 10) ?? todayStr(),
      disposal_amount: property?.disposal_amount?.toString() ?? '',
      disposal_note: property?.disposal_note ?? '',
    });
    setDisposing(true);
  };
  const applyDispose = async () => {
    setErr('');
    try {
      await api.post(`/properties/${id}/dispose`, {
        disposed: true,
        disposed_at: disposeForm.disposed_at || null,
        disposal_type: disposeForm.disposal_type,
        disposal_amount: disposeForm.disposal_amount === '' ? null : Number(disposeForm.disposal_amount),
        disposal_note: disposeForm.disposal_note || null,
      });
      setDisposing(false); loadProperty(); loadSummary();
    } catch (e: any) { setErr(e.message); }
  };
  const restoreOwnership = async () => {
    setErr('');
    try { await api.post(`/properties/${id}/dispose`, { disposed: false }); loadProperty(); loadSummary(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <BackLink to="/properties" label="Back to Properties" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {p.name}
            {p.is_rental && (
              <span className="tag" style={p.is_occupied === false ? { borderColor: 'var(--debit)', color: 'var(--debit)' } : { borderColor: 'var(--income)', color: 'var(--income)' }}>
                Rental · {p.is_occupied === false ? 'Vacant' : 'Occupied'}
              </span>
            )}
            {p.is_new_construction && <span className="tag">New Construction</span>}
            {disposed && <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}>{propertyDisposalTypeLabel(p.disposal_type)}</span>}
          </h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
          <div style={{ marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>Value</span>
            <span className="num" style={{ fontSize: 26, fontWeight: 600 }}>{p.current_value != null ? money(p.current_value) : '—'}</span>
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {disposed && (
        <div className="banner" style={{ marginBottom: 12 }}>
          No longer owned · {propertyDisposalTypeLabel(p.disposal_type)}{p.disposed_at ? ` on ${shortDate(p.disposed_at)}` : ''}
          {p.disposal_amount != null ? ` for ${money(p.disposal_amount)}` : ''}
          {p.disposal_note ? ` — ${p.disposal_note}` : ''}. Its history is preserved; it no longer counts toward net worth. Use “Mark as Owned Again” to reverse this.
        </div>
      )}

      <div className="tabs">
        {TABS.filter((t) => t.key !== 'rental' || rentalLive).map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Value</div><div className="value credit">{money(p.current_value)}</div></div>
            <div className="card stat">
              <div className="label">Mortgage</div>
              {p.mortgage_account_id != null && mortgage <= 0.005
                ? <div className="value credit">Paid off</div>
                : <div className="value debit">{money(mortgage)}</div>}
            </div>
            <div className="card stat"><div className="label">Equity</div><div className={`value ${equity < 0 ? 'debit' : ''}`}>{money(equity)}</div></div>
          </div>

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="label" style={{ marginBottom: 10 }}>Summary</div>
            <FactList items={facts} />
          </div>

          {summary && (
            <>
              <div className="section" style={{ margin: '0 0 12px' }}>Cost &amp; Performance</div>
              <div className="grid grid-3" style={{ marginBottom: 12 }}>
                <div className="card stat"><div className="label">Tagged Spending</div><div className="value debit">{money(summary.totalSpent)}</div></div>
                <div className="card stat"><div className="label">Tagged Income</div><div className="value credit">{money(summary.totalIncome)}</div></div>
                <div className="card stat"><div className="label">Net (Income − Spend)</div><div className={`value ${summary.net < 0 ? 'debit' : 'credit'}`}>{money(summary.net)}</div></div>
              </div>
              <div className="grid grid-3" style={{ marginBottom: 18 }}>
                <div className="card stat"><div className="label">Equity</div><div className="value small">{money(summary.equity)}</div></div>
                <div className="card stat"><div className="label">Appreciation</div><div className="value small">{money(summary.appreciation)}</div></div>
                <div className="card stat">
                  <div className="label">Cost / Month · Owned</div>
                  <div className="value small">{money(summary.costPerMonth)}{summary.monthsOwned != null ? ` · ${summary.monthsOwned} mo` : ''}</div>
                </div>
              </div>
              {(summary.annualRentalIncome != null || summary.grossYield != null) && (
                <div className="grid grid-2" style={{ marginBottom: 18 }}>
                  <div className="card stat"><div className="label">Annual Rent (Stated)</div><div className="value small">{money(summary.annualRentalIncome)}</div></div>
                  <div className="card stat"><div className="label">Gross Yield</div><div className="value small">{summary.grossYield != null ? `${(summary.grossYield * 100).toFixed(2)}%` : '—'}</div></div>
                </div>
              )}

              <div className="card" style={{ padding: 0, marginBottom: 18 }}>
                <table className="ledger">
                  <thead><tr><th>Spending by Category</th><th className="r">Transactions</th><th className="r">Total</th></tr></thead>
                  <tbody>
                    {summary.byCategory.map((c, i) => (
                      <tr key={i}><td>{c.category_name ?? 'Uncategorized'}</td><td className="r num">{c.count}</td><td className="r money num">{money(c.total)}</td></tr>
                    ))}
                    {summary.byCategory.length === 0 && <tr><td colSpan={3}><div className="empty">No expenses tagged to this property yet.</div></td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div className="section" style={{ margin: 0 }}>AI Cost &amp; Rental Analysis</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Sends this property's figures and recent transactions to Claude for a written breakdown.</div>
                  </div>
                  <button className="brass" onClick={runAnalysis} disabled={running}>{running ? 'Analyzing…' : 'Run Analysis'}</button>
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
            <div className="muted" style={{ fontSize: 12 }}>New transactions are automatically tagged to this property.</div>
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
          {allTxns.length === 0 && <TxnTable items={[]} emptyText="No transactions tagged to this property yet." />}
        </>
      )}

      {tab === 'maintenance' && (
        <PropertyMaintenanceTab propertyId={id} onChanged={() => { loadSummary(); loadProperty(); }} />
      )}

      {tab === 'snapshots' && !disposed && <PropertyAutoValue property={p} onChanged={loadProperty} />}
      {tab === 'snapshots' && (
        <SnapshotTab
          items={snaps}
          onAdd={addSnap}
          onDelete={delSnap}
          chartPoints={chartData}
          title="Value Snapshots"
          chartTitle="Value Over Time"
          hint="Record the home's value on a date — the latest snapshot is the current value used in net worth."
          emptyText="No value snapshots yet. Record the home's value on a date — the latest snapshot becomes the current value used in net worth."
          onEstimate={estimateValue}
          estimating={estimating}
          estimateMsg={estimateMsg}
          estimateLabel="Estimate & Record"
        />
      )}

      {tab === 'rental' && rentalLive && (
        <PropertyInfoForm
          property={p}
          isNew={false}
          section="rental"
          onSaved={() => { loadProperty(); loadSummary(); }}
          onChanged={() => { loadProperty(); loadSummary(); }}
        />
      )}

      {tab === 'insurance' && <EntityInsurance basePath={`/properties/${id}`} typeHint="e.g. Homeowners, Flood, Umbrella" />}

      {tab === 'documents' && <EntityDocuments basePath={`/properties/${id}`} docTypes={PROPERTY_DOC_TYPES} />}

      {tab === 'details' && (
        <>
          <PropertyInfoForm
            property={p}
            isNew={false}
            section="details"
            rentalLive={rentalLive}
            onRentalChange={setRentalLive}
            onSaved={() => { loadProperty(); loadSnaps(); loadTxns(); loadSummary(); loadDocs(); }}
            onChanged={() => { loadProperty(); loadSummary(); loadDocs(); }}
            onDeleted={() => navigate('/properties')}
          />

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="section" style={{ margin: 0 }}>Change Ownership</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {disposed
                    ? `No longer owned${p.disposed_at ? ` since ${shortDate(p.disposed_at)}` : ''} — kept for history, excluded from net worth.`
                    : 'Sold, transferred, or foreclosed? Mark it as no longer owned to keep its history without counting it in net worth.'}
                </div>
              </div>
              {disposed
                ? <button className="ghost" onClick={restoreOwnership}>Mark as Owned Again</button>
                : !disposing && <button className="ghost" onClick={startDispose}>No Longer Owned</button>}
            </div>
            {!disposed && disposing && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
                <div className="grid grid-3">
                  <Field label="How It Left">
                    <select value={disposeForm.disposal_type} onChange={(e) => setDisposeForm({ ...disposeForm, disposal_type: e.target.value })}>
                      {PROPERTY_DISPOSAL_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="Date"><input type="date" value={disposeForm.disposed_at} onChange={(e) => setDisposeForm({ ...disposeForm, disposed_at: e.target.value })} /></Field>
                  <Field label="Sale Price (Optional)"><AmountInput value={disposeForm.disposal_amount} onChange={(v) => setDisposeForm({ ...disposeForm, disposal_amount: v })} placeholder="0.00" /></Field>
                </div>
                <Field label="Note (Optional)"><input value={disposeForm.disposal_note} onChange={(e) => setDisposeForm({ ...disposeForm, disposal_note: e.target.value })} placeholder="e.g. sold to the Smiths, transferred to LLC" /></Field>
                <div className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
                  To attach a closing or settlement statement, use the Documents tab.
                </div>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <button className="ghost" onClick={() => setDisposing(false)}>Cancel</button>
                  <button onClick={applyDispose}>Mark as No Longer Owned</button>
                </div>
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
          initialTags={[{ kind: 'property', ref_id: id, name: p.name }]}
          onClose={() => setAddingTxn(false)}
          onSaved={() => { setAddingTxn(false); loadTxns(); loadSummary(); loadProperty(); }}
        />
      )}

      {editingTxn && lookups && (
        <TxnEditor
          txn={editingTxn}
          lookups={lookups}
          purchasers={[]}
          merchants={merchants}
          onClose={() => setEditingTxn(null)}
          onSaved={() => { setEditingTxn(null); loadTxns(); loadSummary(); loadProperty(); }}
        />
      )}
    </>
  );
}

// Days from today to an ISO date (negative = in the past).
const daysUntil = (iso: string) => Math.round((parseLocalDate(iso).getTime() - parseLocalDate(todayStr()).getTime()) / 86_400_000);

// Maintenance tab: scheduled upcoming items (next gutter cleaning, etc.) on top, then
// completed repair/service history (each optionally tied to a tagged transaction).
function PropertyMaintenanceTab({ propertyId, onChanged }: { propertyId: number; onChanged?: () => void }) {
  const [items, setItems] = useState<Maintenance[]>([]);
  const [editing, setEditing] = useState<{ item: Maintenance | null; status: 'completed' | 'upcoming' } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api.get<Maintenance[]>(`/properties/${propertyId}/maintenance`).then(setItems).catch(() => {});
  useEffect(() => { load(); }, [propertyId]);

  const upcoming = items.filter((i) => i.status === 'upcoming');
  const history = items.filter((i) => i.status === 'completed').sort((a, b) => ((a.service_date ?? '') < (b.service_date ?? '') ? 1 : -1));

  const del = async (id: number) => {
    if (!confirm('Delete this maintenance item?')) return;
    try { await api.del(`/properties/${propertyId}/maintenance/${id}`); load(); onChanged?.(); } catch (e: any) { setErr(e.message); }
  };
  const costOf = (m: Maintenance) => (m.transaction_id != null ? m.txn_amount : m.cost);
  const dueInfo = (m: Maintenance) => {
    if (!m.due_date) return { text: '—', overdue: false };
    const days = daysUntil(m.due_date);
    return { text: days < 0 ? `${Math.abs(days)}d overdue` : `${days.toLocaleString()}d`, overdue: days < 0 };
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
          <div className="empty" style={{ padding: '0 14px 14px' }}>Nothing scheduled. Add the next inspection, gutter cleaning, HVAC service, etc.</div>
        ) : (
          <table className="ledger">
            <thead><tr><th>Item</th><th>Due (Date)</th><th className="r">Due In</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {upcoming.map((m) => {
                const d = dueInfo(m);
                return (
                  <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => setEditing({ item: m, status: m.status })}>
                    <td>{m.item}</td>
                    <td className="num">{m.due_date ? shortDate(m.due_date) : '—'}</td>
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
            <thead><tr><th>Date</th><th>Item</th><th>Vendor</th><th className="r">Cost</th><th></th></tr></thead>
            <tbody>
              {history.map((m) => (
                <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => setEditing({ item: m, status: m.status })}>
                  <td className="num">{m.service_date ? shortDate(m.service_date) : '—'}</td>
                  <td>{m.item}{m.notes ? <span className="muted" style={{ fontSize: 12 }}> · {m.notes}</span> : ''}</td>
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
        <PropertyMaintenanceEditor
          propertyId={propertyId}
          item={editing.item}
          defaultStatus={editing.status}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onChanged?.(); }}
        />
      )}
    </>
  );
}

function PropertyMaintenanceEditor({ propertyId, item, defaultStatus, onClose, onSaved }: {
  propertyId: number; item: Maintenance | null; defaultStatus: 'completed' | 'upcoming'; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    item: item?.item ?? '',
    status: (item?.status ?? defaultStatus) as 'completed' | 'upcoming',
    service_date: item?.service_date?.slice(0, 10) ?? (item ? '' : (defaultStatus === 'completed' ? todayStr() : '')),
    cost: item?.cost?.toString() ?? '',
    transaction_id: item?.transaction_id?.toString() ?? '',
    due_date: item?.due_date?.slice(0, 10) ?? '',
    vendor: item?.vendor ?? '',
    notes: item?.notes ?? '',
  });
  const [cands, setCands] = useState<ExpenseCandidate[]>([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const num = (s: string) => (s === '' ? null : Number(s));
  const completed = f.status === 'completed';
  useEffect(() => { api.get<ExpenseCandidate[]>(`/properties/${propertyId}/expense-candidates`).then(setCands).catch(() => {}); }, [propertyId]);

  const markComplete = () => setF((cur) => ({ ...cur, status: 'completed', service_date: cur.service_date || todayStr() }));

  const save = async () => {
    if (!f.item.trim()) { setErr('Describe the maintenance item.'); return; }
    setSaving(true); setErr('');
    try {
      const body = {
        item: f.item, status: f.status,
        service_date: completed ? (f.service_date || null) : null,
        cost: completed ? num(f.cost) : null,
        transaction_id: completed ? num(f.transaction_id) : null,
        due_date: !completed ? (f.due_date || null) : null,
        vendor: f.vendor || null, notes: f.notes || null,
      };
      if (item) await api.put(`/properties/${propertyId}/maintenance/${item.id}`, body);
      else await api.post(`/properties/${propertyId}/maintenance`, body);
      onSaved();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  const candidateLabel = (c: ExpenseCandidate) => `${shortDate(c.txn_date)} · ${money(c.amount)} · ${c.merchant || c.description || c.account_name || 'transaction'}`;

  return (
    <Modal title={item ? `Edit · ${item.item}` : 'Add Maintenance'} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <Field label="Item"><input value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="e.g. Roof repair, HVAC service, gutter cleaning" /></Field>
      <Field label="Type">
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'completed' | 'upcoming' })}>
          <option value="completed">Completed (History)</option>
          <option value="upcoming">Upcoming (Scheduled)</option>
        </select>
      </Field>
      {item && f.status === 'upcoming' && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button type="button" className="brass" onClick={markComplete}>Mark Complete</button>
          <span className="muted" style={{ fontSize: 12, marginLeft: 10, alignSelf: 'center' }}>Records it as done today — adjust the details below, then Save.</span>
        </div>
      )}

      {completed ? (
        <>
          <Field label="Service Date"><input type="date" value={f.service_date} onChange={(e) => setF({ ...f, service_date: e.target.value })} /></Field>
          <Field label="Vendor"><input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} placeholder="e.g. ABC Roofing" /></Field>
          <Field label="Linked Transaction (Optional)">
            <select value={f.transaction_id} onChange={(e) => {
              const tid = e.target.value;
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
        <Field label="Due Date"><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
      )}

      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="optional" /></Field>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : item ? 'Save Changes' : 'Add'}</button>
      </div>
    </Modal>
  );
}

// Editable core property info, rendered inline on the detail page (no popup). Used
// for "Add property" (isNew) and the Details tab of an existing property. A Save
// button enables once something changes. Value snapshots live in their own tab.
function PropertyInfoForm({ property, isNew, section = 'all', rentalLive, onRentalChange, onSaved, onChanged, onDeleted }: {
  property: Property | null; isNew: boolean; section?: 'all' | 'details' | 'rental';
  rentalLive?: boolean; onRentalChange?: (v: boolean) => void;
  onSaved: (p: Property) => void; onChanged?: () => void; onDeleted?: () => void;
}) {
  const navigate = useNavigate();
  const seedOf = (p: Property | null) => ({
    name: p?.name ?? '', property_type: p?.property_type ?? 'single_family',
    address: p?.address ?? '', city: p?.city ?? '', state: p?.state ?? '', zip: p?.zip ?? '',
    current_value: p?.current_value?.toString() ?? '', mortgage_balance: p?.mortgage_balance?.toString() ?? '',
    purchase_price: p?.purchase_price?.toString() ?? '', purchase_date: p?.purchase_date?.slice(0, 10) ?? '',
    year_built: p?.year_built?.toString() ?? '', square_feet: p?.square_feet?.toString() ?? '', lot_size_acres: p?.lot_size_acres?.toString() ?? '',
    bedrooms: p?.bedrooms?.toString() ?? '', bathrooms: p?.bathrooms?.toString() ?? '', stories: p?.stories?.toString() ?? '', garage_spaces: p?.garage_spaces?.toString() ?? '',
    is_new_construction: p?.is_new_construction ?? false,
    rental_income: p?.rental_income?.toString() ?? '', is_rental: p?.is_rental ?? false, is_occupied: p?.is_occupied ?? true,
    tenant_name: p?.tenant_name ?? '', lease_start: p?.lease_start?.slice(0, 10) ?? '', lease_end: p?.lease_end?.slice(0, 10) ?? '',
    security_deposit: p?.security_deposit?.toString() ?? '', legal_description: p?.legal_description ?? '',
    property_tax_annual: p?.property_tax_annual?.toString() ?? '', hoa_dues: p?.hoa_dues?.toString() ?? '', hoa_cycle: p?.hoa_cycle ?? 'monthly',
    notes: p?.notes ?? '',
  });
  const hasMortgageOf = (p: Property | null) => p?.mortgage_account_id != null || Number(p?.mortgage_balance ?? 0) > 0;
  // The rental tab forces a rental; otherwise reflect the live (possibly unsaved) toggle.
  const seedF = (p: Property | null) => ({ ...seedOf(p), is_rental: section === 'rental' ? true : (rentalLive ?? p?.is_rental ?? false) });

  const [f, setF] = useState(() => seedF(property));
  const [hasMortgage, setHasMortgage] = useState(() => hasMortgageOf(property));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify({ f: seedOf(property), hasMortgage: hasMortgageOf(property) }));
  const [linked, setLinked] = useState(() => property?.mortgage_account_id != null
    ? { id: property.mortgage_account_id, name: property.mortgage_account_name ?? 'Mortgage', balance: Number(property.mortgage_account_balance ?? 0) } : null);
  useEffect(() => {
    const s = seedOf(property); const hm = hasMortgageOf(property);
    setF(seedF(property)); setHasMortgage(hm); setSavedJson(JSON.stringify({ f: s, hasMortgage: hm }));
    setLinked(property?.mortgage_account_id != null
      ? { id: property.mortgage_account_id, name: property.mortgage_account_name ?? 'Mortgage', balance: Number(property.mortgage_account_balance ?? 0) } : null);
  }, [property?.id]);
  const dirty = JSON.stringify({ f, hasMortgage }) !== savedJson;

  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimateMsg, setEstimateMsg] = useState('');
  const num = (s: string) => (s === '' ? null : Number(s));

  const buildBody = () => ({
    name: f.name, property_type: f.property_type,
    address: f.address || null, city: f.city || null, state: f.state || null, zip: f.zip || null,
    // Existing properties' value is owned by snapshots; only seed it on create.
    current_value: isNew ? num(f.current_value) : null,
    mortgage_balance: (linked || hasMortgage) ? num(f.mortgage_balance) : null,
    purchase_price: num(f.purchase_price), purchase_date: f.purchase_date || null,
    year_built: num(f.year_built), square_feet: num(f.square_feet), lot_size_acres: num(f.lot_size_acres),
    bedrooms: num(f.bedrooms), bathrooms: num(f.bathrooms), stories: num(f.stories), garage_spaces: num(f.garage_spaces),
    is_new_construction: f.is_new_construction,
    rental_income: f.is_rental ? num(f.rental_income) : null,
    is_rental: section === 'rental' ? true : f.is_rental, is_occupied: f.is_rental ? f.is_occupied : null,
    tenant_name: f.is_rental ? (f.tenant_name || null) : null,
    lease_start: f.is_rental ? (f.lease_start || null) : null,
    lease_end: f.is_rental ? (f.lease_end || null) : null,
    security_deposit: f.is_rental ? num(f.security_deposit) : null,
    legal_description: f.legal_description || null,
    property_tax_annual: num(f.property_tax_annual), hoa_dues: num(f.hoa_dues), hoa_cycle: f.hoa_dues ? f.hoa_cycle : null,
    notes: f.notes || null,
  });

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    try {
      const p = isNew
        ? ({ ...(await api.post<Property>('/properties', buildBody())), total_spent: 0, txn_count: 0, doc_count: 0 } as Property)
        : await api.put<Property>(`/properties/${property!.id}`, buildBody());
      setSavedJson(JSON.stringify({ f, hasMortgage }));
      onSaved(p);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!property || !confirm(`Delete property "${property.name}"?`)) return;
    try { await api.del(`/properties/${property.id}`); onDeleted?.(); } catch (e: any) { setErr(e.message); }
  };

  // For a new property, the estimate fills the value field; existing properties
  // record value snapshots on the Value snapshots tab instead.
  const estimateValue = async () => {
    setErr(''); setEstimateMsg(''); setEstimating(true);
    try {
      const est = await api.post<{ value: number; low: number | null; high: number | null; rationale: string | null; source?: string }>('/properties/estimate-value', {
        property_type: f.property_type, address: f.address || null, city: f.city || null, state: f.state || null, zip: f.zip || null,
        square_feet: num(f.square_feet), lot_size_acres: num(f.lot_size_acres), year_built: num(f.year_built),
        purchase_price: num(f.purchase_price), purchase_date: f.purchase_date || null,
      });
      setF((cur) => ({ ...cur, current_value: String(est.value) }));
      const range = est.low != null && est.high != null ? ` (range ${money(est.low)}–${money(est.high)})` : '';
      setEstimateMsg(`Estimated ${money(est.value)}${range}${est.source === 'rentcast' ? ' (RentCast)' : ' (AI estimate)'}.${est.rationale ? ' ' + est.rationale : ''}`);
    } catch (e: any) { setErr(e.message); }
    finally { setEstimating(false); }
  };

  const setupMortgage = async () => {
    if (!property) return;
    setErr('');
    try {
      const acct = await api.post<{ id: number; name: string; opening_balance: number }>(`/properties/${property.id}/mortgage-account`, { opening_balance: num(f.mortgage_balance) });
      setLinked({ id: acct.id, name: acct.name, balance: Number(acct.opening_balance ?? 0) });
      onChanged?.();
    } catch (e: any) { setErr(e.message); }
  };
  const unlinkMortgage = async () => {
    if (!property || !confirm('Unlink this mortgage account? The account stays in Accounts; you can delete it there.')) return;
    try { await api.del(`/properties/${property.id}/mortgage-account`); setLinked(null); onChanged?.(); } catch (e: any) { setErr(e.message); }
  };

  const showDetails = section === 'all' || section === 'details';
  const showRentalTab = section === 'rental';
  const titleLabel = section === 'rental' ? 'Rental Details' : isNew ? 'New Property' : 'Property Details';

  // Tenant / lease / rent fields — shown inline on the add page and on the Rental tab.
  const rentalFields = (
    <>
      <div className="grid grid-2">
        <Field label="Monthly Rent"><AmountInput value={f.rental_income} onChange={(v) => setF({ ...f, rental_income: v })} placeholder="0.00" /></Field>
        <label className="row" style={{ alignItems: 'center', alignSelf: 'end', marginBottom: 12 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.is_occupied} onChange={(e) => setF({ ...f, is_occupied: e.target.checked })} />
          <span>Currently Occupied</span>
        </label>
      </div>
      <Field label="Tenant Name"><input value={f.tenant_name} onChange={(e) => setF({ ...f, tenant_name: e.target.value })} placeholder="e.g. Jane Doe" /></Field>
      <div className="grid grid-3">
        <Field label="Lease Start"><input type="date" value={f.lease_start} onChange={(e) => setF({ ...f, lease_start: e.target.value })} /></Field>
        <Field label="Lease End"><input type="date" value={f.lease_end} onChange={(e) => setF({ ...f, lease_end: e.target.value })} /></Field>
        <Field label="Security Deposit"><AmountInput value={f.security_deposit} onChange={(v) => setF({ ...f, security_deposit: v })} /></Field>
      </div>
    </>
  );

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>{titleLabel}</div>
        <div className="btn-row">
          {!isNew && onDeleted && section !== 'rental' && <button className="danger" onClick={remove}>Delete</button>}
          <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : isNew ? 'Add Property' : 'Save Changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {showDetails && (
        <>
          <div className="card">
            <Section title="Identity & Details" headStyle={{ marginTop: 6, marginBottom: 6 }}>
              <div className="grid grid-2">
                <Field label="Name (Label)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Lake Cabin" /></Field>
                <Field label="Type">
                  <select value={f.property_type} onChange={(e) => setF({ ...f, property_type: e.target.value })}>
                    {PROPERTY_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Street Address"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="123 Main St" /></Field>
              <div className="grid grid-3">
                <Field label="City"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
                <Field label="State"><input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} placeholder="e.g. CA" /></Field>
                <Field label="ZIP"><input value={f.zip} onChange={(e) => setF({ ...f, zip: e.target.value })} /></Field>
              </div>

              <EditorSection title="Specifications" />
              <div className="grid grid-4">
                <Field label="Bedrooms"><input className="num-input" inputMode="numeric" value={f.bedrooms} onChange={(e) => setF({ ...f, bedrooms: e.target.value })} placeholder="e.g. 3" /></Field>
                <Field label="Bathrooms"><input className="num-input" inputMode="decimal" value={f.bathrooms} onChange={(e) => setF({ ...f, bathrooms: e.target.value })} placeholder="e.g. 2.5" /></Field>
                <Field label="Stories"><input className="num-input" inputMode="numeric" value={f.stories} onChange={(e) => setF({ ...f, stories: e.target.value })} placeholder="e.g. 2" /></Field>
                <Field label="Garage Spaces"><input className="num-input" inputMode="numeric" value={f.garage_spaces} onChange={(e) => setF({ ...f, garage_spaces: e.target.value })} placeholder="e.g. 2" /></Field>
              </div>
              <div className="grid grid-3">
                <Field label="Year Built"><input className="num-input" inputMode="numeric" value={f.year_built} onChange={(e) => setF({ ...f, year_built: e.target.value })} /></Field>
                <Field label="Square Feet"><input className="num-input" inputMode="numeric" value={f.square_feet} onChange={(e) => setF({ ...f, square_feet: e.target.value })} /></Field>
                <Field label="Lot Size (Acres)"><input className="num-input" inputMode="decimal" value={f.lot_size_acres} onChange={(e) => setF({ ...f, lot_size_acres: e.target.value })} placeholder="e.g. 0.25" /></Field>
              </div>

              <EditorSection title="Notes" />
              <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            </Section>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <Section title="Ownership & Financing" headStyle={{ marginTop: 6, marginBottom: 6 }}>
              <label className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={f.is_new_construction} onChange={(e) => setF({ ...f, is_new_construction: e.target.checked })} />
                <span>New construction (built, not purchased)</span>
              </label>
              {f.is_new_construction && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>For new construction, enter the build cost and completion date below — they're used as the purchase price and date.</div>
              )}
              <div className="grid grid-2">
                <Field label={f.is_new_construction ? 'Completion Date' : 'Purchase Date'}><input type="date" value={f.purchase_date} onChange={(e) => setF({ ...f, purchase_date: e.target.value })} /></Field>
                <Field label={f.is_new_construction ? 'Construction Cost' : 'Purchase Price'}><AmountInput value={f.purchase_price} onChange={(v) => setF({ ...f, purchase_price: v })} /></Field>
              </div>

              {isNew && (
                <>
                  <EditorSection title="Value" />
                  <Field label="Current Value">
                    <div className="row" style={{ gap: 8 }}>
                      <AmountInput value={f.current_value} onChange={(v) => { setF({ ...f, current_value: v }); setEstimateMsg(''); }} placeholder="Enter manually or estimate" style={{ flex: 1 }} />
                      <button type="button" className="brass" onClick={estimateValue} disabled={estimating}>{estimating ? 'Estimating…' : 'Estimate'}</button>
                    </div>
                  </Field>
                  {estimateMsg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{estimateMsg}</div>}
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>After saving, record value over time on the Value tab.</div>
                </>
              )}

              <EditorSection title="Mortgage" />
              {linked ? (
                <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  {linked.balance <= 0.005
                    ? <span className="tag" style={{ borderColor: 'var(--income)', color: 'var(--income)' }}>Paid off</span>
                    : <span className="tag">Managed as account</span>}
                  <span className="muted" style={{ fontSize: 13 }}>{linked.name} · {linked.balance <= 0.005 ? '$0.00 owed' : `${money(linked.balance)} owed`}</span>
                  <button className="ghost" style={{ padding: '3px 10px' }} onClick={() => navigate('/accounts')}>Open in Accounts</button>
                  <button className="ghost" style={{ padding: '3px 10px' }} onClick={unlinkMortgage}>Unlink</button>
                </div>
              ) : (
                <>
                  <label className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={hasMortgage} onChange={(e) => setHasMortgage(e.target.checked)} />
                    <span>Money is owed on this property (mortgage or loan)</span>
                  </label>
                  {!hasMortgage ? (
                    <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Owned free and clear — no mortgage.</div>
                  ) : (
                    <>
                      <Field label="Amount Owed"><AmountInput value={f.mortgage_balance} onChange={(v) => setF({ ...f, mortgage_balance: v })} placeholder="0.00" /></Field>
                      {isNew ? (
                        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Save first to create a linked mortgage account (balance snapshots, rate, due day) in Accounts.</div>
                      ) : (
                        <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
                          <button className="ghost" onClick={setupMortgage}>Set Up Mortgage Account</button>
                          <span className="muted" style={{ fontSize: 12 }}>Creates a liability account in Accounts — pay it down there and it shows Paid off at $0.</span>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              <EditorSection title="Taxes & Dues" />
              <div className="grid grid-3">
                <Field label="Annual Property Tax"><AmountInput value={f.property_tax_annual} onChange={(v) => setF({ ...f, property_tax_annual: v })} placeholder="0.00" /></Field>
                <Field label="HOA Dues"><AmountInput value={f.hoa_dues} onChange={(v) => setF({ ...f, hoa_dues: v })} placeholder="0.00" /></Field>
                <Field label="HOA Cycle">
                  <select value={f.hoa_cycle} onChange={(e) => setF({ ...f, hoa_cycle: e.target.value })}>
                    {[['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['semiannual', 'Semi-Annual'], ['annual', 'Annual']].map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </Field>
              </div>

              <EditorSection title="Legal & Title" />
              <Field label="Legal Description"><textarea rows={3} value={f.legal_description} onChange={(e) => setF({ ...f, legal_description: e.target.value })} placeholder="Lot/block, parcel number, deed legal description…" /></Field>
            </Section>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <Section title="Rental" headStyle={{ marginTop: 6, marginBottom: 6 }}>
              <label className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={f.is_rental} onChange={(e) => { setF({ ...f, is_rental: e.target.checked }); onRentalChange?.(e.target.checked); }} />
                <span>This is a rental property</span>
              </label>
              {f.is_rental && (section === 'all'
                ? rentalFields
                : <div className="muted" style={{ fontSize: 12 }}>Manage tenant, lease, and rent on the <strong>Rental</strong> tab — it appears as soon as this is checked.</div>)}
            </Section>
          </div>

        </>
      )}

      {showRentalTab && (
        <div className="card">
          <Section title="Rental" headStyle={{ marginTop: 6, marginBottom: 6 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>Tenant, lease, and rent details for this rental property.</div>
            {rentalFields}
          </Section>
        </div>
      )}
    </>
  );
}
