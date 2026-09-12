import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, money, shortDate, todayStr, parseLocalDate, accountTypeLabel, isHttpUrl, isOpenableUrl, normalizeUrl, formatPhone, ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES } from '../api';
import { cap, chartTooltip, BackLink, Field, AmountInput, EditorSection, Loading } from '../components/ui';
import { type Filters, DEFAULT_FILTERS, chip, buildTxnParams, TxnFilterBar } from '../components/txnFilters';
import { SnapshotTab } from '../components/SnapshotTab';
import { EntityDocuments } from '../components/EntityDocuments';
import { EntityBeneficiaries } from '../components/EntityBeneficiaries';
import { useAuth } from '../auth';
import { TxnEditor } from './transactions/TxnEditor';
import { TxnTable } from './transactions/TxnTable';
import type { Lookups, Txn } from './transactions/helpers';
import { accountGroupLabel, type Account } from './Accounts';
import type { Category } from '../types';

interface Snapshot { id: number; as_of: string; balance: number; auto_imported?: boolean }
interface Holding { id: number; symbol: string | null; description: string | null; shares: number | null; market_value: number | null; cost_basis: number | null; currency: string | null; as_of: string | null }
interface TxnPage { pending: Txn[]; pendingTotal: number; posted: Txn[]; total: number }

// Build the balance-over-time series (opening balance → snapshots → current balance)
// and downsample it so the chart never draws more than ~CHART_MAX points. A daily
// bank-synced account accrues thousands of snapshots over the years; at screen
// resolution an even sample is visually identical and far cheaper to render.
const CHART_MAX = 400;
function buildBalanceSeries(a: Account, ascSnaps: Snapshot[], txnsByDate: Txn[]): { as_of: string; value: number }[] {
  const today = todayStr();
  const isoDaysAgo = (d: string, n: number) => {
    const dt = parseLocalDate(d); dt.setDate(dt.getDate() - n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const earliestActivity = ascSnaps[0]?.as_of ?? (txnsByDate.length ? txnsByDate[txnsByDate.length - 1].txn_date : null);
  let openingDate = a.opening_date?.slice(0, 10) || earliestActivity || today;
  if (openingDate >= today) openingDate = isoDaysAgo(today, 1); // keep opening before "now"
  const pts: { as_of: string; value: number }[] = [];
  if (a.opening_balance != null) pts.push({ as_of: openingDate, value: Number(a.opening_balance) });
  for (const s of ascSnaps) pts.push({ as_of: s.as_of, value: Number(s.balance) });
  const curVal = Number(a.posted_balance ?? 0);
  const lastPt = pts[pts.length - 1];
  if (!lastPt || lastPt.as_of !== today) pts.push({ as_of: today, value: curVal });
  else lastPt.value = curVal;
  if (pts.length <= CHART_MAX) return pts;
  // Even sample, always keeping the first and last points.
  const step = (pts.length - 1) / (CHART_MAX - 1);
  const out: { as_of: string; value: number }[] = [];
  for (let i = 0; i < CHART_MAX; i++) out.push(pts[Math.round(i * step)]);
  out[out.length - 1] = pts[pts.length - 1];
  return out;
}

type Cap = 'beneficiaries' | 'retirement' | 'card' | 'loan';
type Tab = 'overview' | 'snapshots' | 'holdings' | 'transactions' | 'retirement' | 'card' | 'loan' | 'beneficiaries' | 'documents' | 'details';
// Capability tabs appear only when their flag is set (mirrors the property Rental tab).
const TABS: { key: Tab; label: string; cap?: Cap }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'snapshots', label: 'Balance' },
  { key: 'holdings', label: 'Holdings' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'retirement', label: 'Retirement', cap: 'retirement' },
  { key: 'card', label: 'Card', cap: 'card' },
  { key: 'loan', label: 'Loan', cap: 'loan' },
  { key: 'beneficiaries', label: 'Beneficiaries', cap: 'beneficiaries' },
  { key: 'documents', label: 'Documents' },
  { key: 'details', label: 'Details' },
];
type Caps = Record<Cap, boolean>;
const capsOf = (a: Account | null): Caps => ({
  beneficiaries: !!a?.has_beneficiaries, retirement: !!a?.is_retirement, card: !!a?.is_card, loan: !!a?.is_loan,
});
const OWNERSHIP_TYPES: [string, string][] = [['individual', 'Individual'], ['joint', 'Joint'], ['custodial', 'Custodial'], ['trust', 'Trust']];
interface Member { id: number; name: string | null; email: string }

// Document categories for a bank account (statements, tax forms, agreements, …).
const ACCOUNT_DOC_TYPES: [string, string][] = [
  ['statement', 'Statement'],
  ['tax_form', 'Tax Form'],
  ['agreement', 'Agreement'],
  ['disclosure', 'Disclosure'],
  ['correspondence', 'Correspondence'],
  ['other', 'Other'],
];

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Previous / Next pager for a server-side-paginated list. `top` flips the spacing
// so it sits cleanly above the table as well as below it.
function Pager({ page, pageCount, total, start, count, onPage, top }: {
  page: number; pageCount: number; total: number; start: number; count: number; onPage: (p: number) => void; top?: boolean;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', [top ? 'marginBottom' : 'marginTop']: 10 }}>
      <span className="muted num" style={{ fontSize: 13 }}>Showing {start + 1}–{start + count} of {total}</span>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="ghost" style={chip} disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>Previous</button>
        <span className="muted num" style={{ fontSize: 13 }}>Page {page + 1} of {pageCount}</span>
        <button className="ghost" style={chip} disabled={page >= pageCount - 1} onClick={() => onPage(Math.min(pageCount - 1, page + 1))}>Next</button>
      </div>
    </div>
  );
}

const TXN_PAGE = 50;

function FactList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="detail-list">
      {items.map((f, i) => (<div key={i} className="detail-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>))}
    </dl>
  );
}

// Section heading used inside the white section cards (mirrors the Vehicles detail layout).
function Section({ title, children, headStyle }: { title: string; children: ReactNode; headStyle?: CSSProperties }) {
  return (<><div className="label" style={headStyle}>{title}</div>{children}</>);
}

export default function AccountDetail() {
  const { accountId } = useParams();
  const isNew = accountId === 'new';
  // ?treatment=asset|liability (from the Asset/Liability Accounts pages) scopes the
  // new-account type dropdown; ?liability=1 is the legacy liability shortcut.
  const newSearch = new URLSearchParams(useLocation().search);
  const newTreatment = newSearch.get('treatment') === 'asset' ? 'asset' : (newSearch.get('treatment') === 'liability' || newSearch.get('liability') === '1') ? 'liability' : undefined;
  const liabilityDefault = newTreatment === 'liability';
  const id = Number(accountId);
  const navigate = useNavigate();
  const [account, setAccount] = useState<Account | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [txns, setTxns] = useState<TxnPage | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  // Live capability flags drive which detail tabs are visible (mirrors the property
  // Rental tab). Seeded from the account; the Details form previews toggles live.
  const [caps, setCaps] = useState<Caps>(capsOf(null));
  const [members, setMembers] = useState<Member[]>([]);
  const { activeBook } = useAuth();
  const [err, setErr] = useState('');
  // Transactions tab: filtered + server-paginated (50/page), independent of the
  // Overview's recent list. The account filter is hidden since we're scoped here.
  const [tabTxns, setTabTxns] = useState<TxnPage | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingPage, setPendingPage] = useState(0);
  const [postedPage, setPostedPage] = useState(0);
  const [lookups, setLookups] = useState<{
    categories: Category[]; vehicles: { id: number; name: string }[];
    properties: { id: number; name: string }[]; tags: { id: number; name: string }[];
  }>({ categories: [], vehicles: [], properties: [], tags: [] });
  // Inline "Close account" flow (bottom of the Details tab).
  const [closing, setClosing] = useState(false);
  const [closeDate, setCloseDate] = useState('');
  const [closeReason, setCloseReason] = useState('');
  // "Add transaction" editor (Transactions tab): full lookups + merchants loaded
  // lazily the first time the tab is opened, so other tabs don't pay for it.
  const [addingTxn, setAddingTxn] = useState(false);
  const [editingTxn, setEditingTxn] = useState<Txn | null>(null);
  const [editorLookups, setEditorLookups] = useState<Lookups | null>(null);
  const [merchants, setMerchants] = useState<string[]>([]);

  const loadAccount = () => api.get<Account>(`/accounts/${id}`)
    .then((a) => { setAccount(a); setCaps(capsOf(a)); })
    .catch((e) => setErr(e.message));
  const loadSnaps = () => api.get<Snapshot[]>(`/accounts/${id}/balances`).then(setSnaps).catch(() => {});
  const loadHoldings = () => api.get<Holding[]>(`/accounts/${id}/holdings`).then(setHoldings).catch(() => {});

  // Account lifecycle + reconciliation actions.
  const setArchived = async (archived: boolean) => {
    try { await api.post(`/accounts/${id}/archive`, { archived }); loadAccount(); } catch (e: any) { setErr(e.message); }
  };
  const setClosed = async (closed: boolean) => {
    if (closed && !confirm('Close this account? It will be archived and hidden from the default list, but all its transactions are kept.')) return;
    try { await api.post(`/accounts/${id}/close`, { closed }); loadAccount(); } catch (e: any) { setErr(e.message); }
  };
  const startClose = () => { setCloseDate(todayStr()); setCloseReason(''); setClosing(true); };
  const doClose = async () => {
    try {
      await api.post(`/accounts/${id}/close`, { closed: true, closed_at: closeDate || todayStr(), close_reason: closeReason.trim() || null });
      setClosing(false); setCloseReason(''); loadAccount();
    } catch (e: any) { setErr(e.message); }
  };
  // Overview list + balance chart: the most recent page of activity for this
  // account, unfiltered. The Overview only shows the latest 8 (with a "View all"
  // link to the fully-paginated Transactions tab), so one page is plenty.
  const loadTxns = () => api.get<TxnPage>(`/transactions?account_id=${id}&limit=${TXN_PAGE}`).then(setTxns).catch(() => {});

  const tabQs = useMemo(() => buildTxnParams(filters).toString(), [filters]);
  const loadTabTxns = () => {
    const p = buildTxnParams(filters);
    p.set('account_id', String(id));
    p.set('limit', String(TXN_PAGE));
    p.set('pendingOffset', String(pendingPage * TXN_PAGE));
    p.set('postedOffset', String(postedPage * TXN_PAGE));
    api.get<TxnPage>(`/transactions?${p.toString()}`).then(setTabTxns).catch(() => {});
  };

  useEffect(() => {
    if (isNew) return; // "new" mode renders an empty info form; nothing to load
    if (!Number.isFinite(id)) { setErr('Invalid account.'); return; }
    loadAccount(); loadSnaps(); loadHoldings(); loadTxns();
    Promise.all([
      api.get<Category[]>('/categories').catch(() => []),
      api.get<{ id: number; name: string }[]>('/vehicles').catch(() => []),
      api.get<{ id: number; name: string }[]>('/properties').catch(() => []),
      api.get<{ id: number; name: string; archived?: boolean }[]>('/tags').catch(() => []),
    ]).then(([categories, vehicles, properties, tags]) =>
      setLookups({ categories, vehicles, properties, tags: tags.filter((t) => !t.archived) }));
  }, [id]);

  // Reload the (filtered, paginated) tab list when the filter or page changes.
  useEffect(() => { if (Number.isFinite(id)) loadTabTxns(); }, [id, tabQs, pendingPage, postedPage]);

  // Full lookups for the transaction editor — loaded lazily the first time a tab
  // with a clickable transaction list (Overview or Transactions) is opened.
  useEffect(() => {
    if (isNew || (tab !== 'transactions' && tab !== 'overview') || editorLookups) return;
    Promise.all([
      api.get<any[]>('/categories').catch(() => []),
      api.get<any[]>('/accounts').catch(() => []),
      api.get<any[]>('/vehicles').catch(() => []),
      api.get<any[]>('/properties').catch(() => []),
      api.get<any[]>('/subscriptions').catch(() => []),
      api.get<any[]>('/tags').catch(() => []),
    ]).then(([categories, accounts, vehicles, properties, subscriptions, tags]) =>
      setEditorLookups({ categories, accounts, vehicles, properties, subscriptions, tags: tags.filter((t: any) => !t.archived) } as Lookups));
    api.get<string[]>('/transactions/merchants').then(setMerchants).catch(() => {});
  }, [tab]);
  // Jump both lists back to the first page whenever the filter changes.
  useEffect(() => { setPendingPage(0); setPostedPage(0); }, [tabQs]);

  // Book members for the owner picker.
  useEffect(() => { if (activeBook) api.get<Member[]>(`/books/${activeBook.id}/members`).then(setMembers).catch(() => {}); }, [activeBook?.id]);
  // If the open tab's capability gets turned off (or Holdings empties), fall back.
  useEffect(() => {
    const t = TABS.find((x) => x.key === tab);
    if (t?.cap && !caps[t.cap]) setTab('details');
    else if (tab === 'holdings' && holdings.length === 0) setTab('overview');
  }, [caps, tab, holdings.length]);

  // Derived balance/transaction views, memoized so they're not re-sorted/rebuilt on
  // every render (tab switch, modal open, keystroke). A long-lived account can hold
  // thousands of daily synced snapshots, so these were a real per-render cost.
  const sortedSnaps = useMemo(() => [...snaps].sort((x, y) => (x.as_of < y.as_of ? 1 : -1)), [snaps]);
  const ascSnaps = useMemo(() => [...snaps].sort((x, y) => (x.as_of < y.as_of ? -1 : 1)), [snaps]);
  // Pending transactions first (newest-first within each group), then posted — so a
  // pending row never sinks below newer posted rows and drops out of the "Recent" list.
  const { pendingTxns, postedTxns } = useMemo(() => {
    const byDateDesc = (x: Txn, y: Txn) => (x.txn_date < y.txn_date ? 1 : -1);
    return {
      pendingTxns: (txns?.pending ?? []).slice().sort(byDateDesc),
      postedTxns: (txns?.posted ?? []).slice().sort(byDateDesc),
    };
  }, [txns]);
  const txnsByDate = useMemo(() => [...pendingTxns, ...postedTxns], [pendingTxns, postedTxns]);
  const chartData = useMemo(() => (account ? buildBalanceSeries(account, ascSnaps, txnsByDate) : []), [account, ascSnaps, txnsByDate]);

  // "Add account" — render the info form directly on the page (no popup). Saving
  // creates the account and navigates to its full detail page.
  if (isNew) {
    return (
      <>
        <BackLink to="/accounts" label="Back to Accounts" />
        <div className="page-head" style={{ marginTop: 10 }}>
          <div>
            <h1 className="title">{liabilityDefault ? 'Add liability' : 'Add account'}</h1>
            <p className="subtitle">Enter the details and Save. You can record balance snapshots, archive/close it, and reconcile after saving.</p>
          </div>
        </div>
        <AccountInfoForm account={null} isNew liabilityDefault={liabilityDefault} typeFilter={newTreatment} members={members} onSaved={(na) => navigate(`/accounts/${na.id}`)} />
      </>
    );
  }

  if (err && !account) {
    return (<><BackLink to="/accounts" label="Back to Accounts" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>);
  }
  if (!account) return <Loading />;

  const a = account;
  const isLiab = a.is_liability;
  const balanceLabel = isLiab ? 'Amount owed' : 'Current balance';
  const groupLabel = accountGroupLabel(a);
  const subtitle = [a.institution, accountTypeLabel(a.type), groupLabel].filter(Boolean).join(' · ');
  const pendingDiffers = Number(a.pending_balance ?? 0) !== Number(a.posted_balance ?? 0);

  const lastSnap = sortedSnaps[0] ?? null;

  const recentTxns = txnsByDate.slice(0, 8);

  // Transactions tab: the current (filtered) server page for each group.
  const tabPending = tabTxns?.pending ?? [];
  const tabPosted = tabTxns?.posted ?? [];
  const tabPendingTotal = tabTxns?.pendingTotal ?? 0;
  const tabPostedTotal = tabTxns?.total ?? 0;
  const pendingPageCount = Math.max(1, Math.ceil(tabPendingTotal / TXN_PAGE));
  const postedPageCount = Math.max(1, Math.ceil(tabPostedTotal / TXN_PAGE));
  const tabFiltered = filters.q !== '' || filters.range !== DEFAULT_FILTERS.range
    || !!(filters.category_id || filters.vehicle_id || filters.property_id || filters.tag_id || filters.channel)
    || !!(filters.amount_op && filters.amount);

  const bal = Number(a.posted_balance ?? 0);
  const available = a.credit_limit != null ? a.credit_limit - bal : null;
  const utilization = a.credit_limit != null && a.credit_limit > 0 ? (bal / a.credit_limit) * 100 : null;

  // Overview facts. Only push values that exist — never invent data.
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Account treatment', value: isLiab ? 'Liability' : 'Asset' },
    { label: 'Last snapshot', value: lastSnap ? shortDate(lastSnap.as_of) : '—' },
    // Reconciliation is hidden until the full statement-matching flow is built — the
    // backend exists but there's no UI to clear items / finish a session yet.
  ];
  if (pendingDiffers) facts.push({ label: 'Pending balance', value: <span className={isLiab ? 'debit' : ''}>{money(a.pending_balance)}</span> });
  if (a.type === 'credit_card') {
    if (a.credit_limit != null) facts.push({ label: 'Credit limit', value: money(a.credit_limit) });
    if (available != null) facts.push({ label: 'Available credit', value: money(available) });
    if (utilization != null) facts.push({ label: 'Utilization', value: `${utilization.toFixed(0)}%` });
    if (a.due_day != null) facts.push({ label: 'Payment due day', value: ordinal(a.due_day) });
  }
  if (a.type === 'loan' || a.type === 'mortgage') {
    if (a.interest_rate != null) facts.push({ label: 'Interest rate / APR', value: `${a.interest_rate}%` });
    if (a.due_day != null) facts.push({ label: 'Payment due day', value: ordinal(a.due_day) });
  }

  const addSnap = async (as_of: string, value: number) => {
    await api.post(`/accounts/${id}/balances`, { as_of, balance: value });
    loadSnaps(); loadAccount();
  };
  const delSnap = async (snapId: number) => {
    try { await api.del(`/accounts/${id}/balances/${snapId}`); loadSnaps(); loadAccount(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <BackLink to={isLiab ? '/liability-accounts' : '/asset-accounts'} label="Back to Accounts" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {a.name}
            {a.status === 'closed' ? <span className="tag">Closed</span>
              : a.closed_at ? <span className="tag">Closes {shortDate(a.closed_at)}</span>
              : a.archived_at ? <span className="tag">Archived</span> : null}
            {a.auto_synced && (
              <span className="tag" title="Transactions are imported automatically from this linked connection. Manage it in Account → Linked accounts."
                style={{ color: 'var(--credit)', borderColor: 'var(--credit)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                ⟳ Auto-synced{a.sync_provider === 'simplefin' ? ' · SimpleFIN' : a.sync_provider ? ` · ${a.sync_provider}` : ''}
              </span>
            )}
          </h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
          <div style={{ marginTop: 10 }}>
            <span className={`num ${isLiab ? 'debit' : ''}`} style={{ fontSize: 26, fontWeight: 600 }}>{money(a.posted_balance)}</span>
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="tabs">
        {TABS.filter((t) => (t.key === 'holdings' ? holdings.length > 0 : (!t.cap || caps[t.cap]))).map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="label" style={{ marginBottom: 10 }}>Summary</div>
            <FactList items={facts} />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="label" style={{ marginBottom: 8 }}>Balance over time</div>
            {chartData.length >= 2 ? (
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="as_of" tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false}
                      tickFormatter={(d: string) => shortDate(d)} minTickGap={24} />
                    <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={56}
                      tickFormatter={(v: number) => '$' + Math.round(v / 1000) + 'k'} />
                    <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [money(Number(v)), balanceLabel]} labelFormatter={(d) => shortDate(String(d))} />
                    <Area type="monotone" dataKey="value" stroke="#5A6F87" fill="#5A6F87" fillOpacity={0.15} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="empty">Balance history will appear after more snapshots or transactions are available.</div>
            )}
          </div>

          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '0 0 8px' }}>
            <div className="label">Recent transactions</div>
            {recentTxns.length > 0 && <button className="ghost" style={{ padding: '2px 10px' }} onClick={() => setTab('transactions')}>View all</button>}
          </div>
          <TxnTable items={recentTxns} onEdit={editorLookups ? setEditingTxn : undefined} emptyText="No transactions for this account yet." />
        </>
      )}

      {tab === 'transactions' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>New transactions are added to this account.</div>
            <button onClick={() => setAddingTxn(true)} disabled={!editorLookups}>{editorLookups ? 'Add Transaction' : 'Loading…'}</button>
          </div>
          <TxnFilterBar
            filters={filters}
            setFilters={setFilters}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
            lookups={{ accounts: [], categories: lookups.categories, vehicles: lookups.vehicles, properties: lookups.properties, tags: lookups.tags }}
            showAccount={false}
          />
          {tabPending.length > 0 && (
            <div style={{ marginBottom: tabPosted.length ? 18 : 0 }}>
              <div className="label" style={{ marginBottom: 8, color: 'var(--brass-deep)' }}>
                Pending · {tabPendingTotal} awaiting posting
              </div>
              <Pager top page={pendingPage} pageCount={pendingPageCount} total={tabPendingTotal}
                start={pendingPage * TXN_PAGE} count={tabPending.length} onPage={setPendingPage} />
              <TxnTable items={tabPending} onEdit={editorLookups ? setEditingTxn : undefined} />
              <Pager page={pendingPage} pageCount={pendingPageCount} total={tabPendingTotal}
                start={pendingPage * TXN_PAGE} count={tabPending.length} onPage={setPendingPage} />
            </div>
          )}
          {tabPosted.length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 8 }}>{tabPending.length > 0 ? 'Posted' : 'Transactions'}</div>
              <Pager top page={postedPage} pageCount={postedPageCount} total={tabPostedTotal}
                start={postedPage * TXN_PAGE} count={tabPosted.length} onPage={setPostedPage} />
              <TxnTable items={tabPosted} onEdit={editorLookups ? setEditingTxn : undefined} />
              <Pager page={postedPage} pageCount={postedPageCount} total={tabPostedTotal}
                start={postedPage * TXN_PAGE} count={tabPosted.length} onPage={setPostedPage} />
            </>
          )}
          {tabPending.length === 0 && tabPosted.length === 0 && (
            <div className="empty">{tabFiltered ? 'No transactions match these filters.' : 'No transactions for this account yet.'}</div>
          )}
        </>
      )}

      {tab === 'snapshots' && (
        <SnapshotTab
          items={snaps.map((s) => ({ id: s.id, as_of: s.as_of, value: Number(s.balance), auto: s.auto_imported }))}
          onAdd={addSnap}
          onDelete={delSnap}
          title="Balance Snapshots"
          chartTitle="Balance Over Time"
          valueLabel={isLiab ? 'Balance Owed' : 'Balance'}
          addLabel="Add Snapshot"
          chartColor={isLiab ? '#A15648' : '#6B7F6E'}
          hint={isLiab
            ? 'Because this is a liability account, enter the amount owed as a positive number. The latest snapshot anchors the computed balance.'
            : 'Record the balance as of a date. The latest snapshot anchors the computed balance.'}
          emptyText={a.opening_balance != null
            ? <>No snapshots yet — the balance is anchored on the <strong>opening balance of {money(a.opening_balance)}</strong>{a.opening_date ? <> (as of {shortDate(a.opening_date)})</> : ''}, then adjusted by transactions. Add a snapshot from a statement to set a new anchor.</>
            : undefined}
        />
      )}

      {tab === 'holdings' && (() => {
        const total = holdings.reduce((s, h) => s + (h.market_value ?? 0), 0);
        const asOf = holdings.find((h) => h.as_of)?.as_of ?? null;
        return (
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', padding: '12px 14px' }}>
              <div className="label" style={{ margin: 0 }}>Holdings · {holdings.length}</div>
              <div className="muted" style={{ fontSize: 12 }}>{asOf ? `As of ${shortDate(asOf)} · ` : ''}auto-imported</div>
            </div>
            <table className="ledger">
              <thead><tr><th>Symbol</th><th>Holding</th><th className="r">Shares</th><th className="r">Market Value</th><th className="r">%</th></tr></thead>
              <tbody>
                {holdings.map((h) => {
                  const pct = total > 0 ? ((h.market_value ?? 0) / total) * 100 : 0;
                  return (
                    <tr key={h.id}>
                      <td className="num"><strong>{h.symbol || '—'}</strong></td>
                      <td className="muted" style={{ fontSize: 12 }}>{h.description || '—'}</td>
                      <td className="r num">{h.shares != null ? h.shares.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}</td>
                      <td className="r money num">{h.market_value != null ? money(h.market_value) : '—'}</td>
                      <td className="r num muted" style={{ fontSize: 12 }}>{pct.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--hairline)' }}>
                  <td colSpan={3}><strong>Total</strong></td>
                  <td className="r money num"><strong>{money(total)}</strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
            <div className="muted" style={{ fontSize: 12, padding: '8px 14px' }}>Positions are imported from your linked provider and replaced on each sync.</div>
          </div>
        );
      })()}

      {tab === 'retirement' && <CapabilityForm account={a} fields={RETIREMENT_FIELDS} title="Retirement" onSaved={loadAccount} />}
      {tab === 'card' && <CapabilityForm account={a} fields={CARD_FIELDS} title="Card" onSaved={loadAccount} />}
      {tab === 'loan' && <CapabilityForm account={a} fields={LOAN_FIELDS} title="Loan" onSaved={loadAccount} />}
      {tab === 'beneficiaries' && <EntityBeneficiaries basePath={`/accounts/${id}`} />}

      {tab === 'documents' && <EntityDocuments basePath={`/accounts/${id}`} docTypes={ACCOUNT_DOC_TYPES} />}

      {tab === 'details' && (
        <>
          <AccountInfoForm
            account={a}
            isNew={false}
            members={members}
            onCapsChange={setCaps}
            onSaved={() => { loadAccount(); loadSnaps(); loadTxns(); }}
            onDeleted={() => navigate('/accounts')}
          />

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'nowrap', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="section" style={{ margin: 0 }}>Close Account</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {a.status === 'closed'
                    ? `Closed${a.closed_at ? ` as of ${shortDate(a.closed_at)}` : ''}${a.close_reason ? ` — ${a.close_reason}` : ''}. Its transactions and balance history are kept.`
                    : a.closed_at
                      ? `Scheduled to close on ${shortDate(a.closed_at)}${a.close_reason ? ` — ${a.close_reason}` : ''}. Stays active until then; reopen to clear it.`
                      : 'Switched banks or paid it off? Close this account to archive it and hide it from the default list — all of its transactions are kept. Pick a future date to schedule it.'}
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                {a.closed_at
                  ? <button className="ghost" onClick={() => setClosed(false)}>Reopen Account</button>
                  : !closing && <button className="ghost" onClick={startClose}>Close Account</button>}
              </div>
            </div>
            {!a.closed_at && closing && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
                <div className="grid grid-2">
                  <Field label="Close Date"><input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} /></Field>
                  <Field label="Reason (Optional)"><input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="e.g. Switched banks, paid off" /></Field>
                </div>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <button className="ghost" onClick={() => setClosing(false)}>Cancel</button>
                  <button onClick={doClose}>Close Account</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {addingTxn && editorLookups && (
        <TxnEditor
          txn={null}
          lookups={editorLookups}
          purchasers={[]}
          merchants={merchants}
          initialAccountId={id}
          onClose={() => setAddingTxn(false)}
          onSaved={() => { setAddingTxn(false); loadTabTxns(); loadTxns(); loadAccount(); loadSnaps(); }}
        />
      )}

      {editingTxn && editorLookups && (
        <TxnEditor
          txn={editingTxn}
          lookups={editorLookups}
          purchasers={[]}
          merchants={merchants}
          onClose={() => setEditingTxn(null)}
          onSaved={() => { setEditingTxn(null); loadTabTxns(); loadTxns(); loadAccount(); loadSnaps(); }}
        />
      )}
    </>
  );
}

// Editable core account info, rendered inline on the detail page (no popup). Used
// for "Add account" (isNew) and the Details tab of an existing account. A Save
// button enables once something changes. Balance snapshots live in their own tab.
function AccountInfoForm({ account, isNew, liabilityDefault, typeFilter, members = [], onCapsChange, onSaved, onDeleted }: {
  account: Account | null; isNew: boolean; liabilityDefault?: boolean; typeFilter?: 'asset' | 'liability'; members?: Member[];
  onCapsChange?: (c: Caps) => void; onSaved: (a: Account) => void; onDeleted?: () => void;
}) {
  const seedOf = (a: Account | null) => ({
    name: a?.name ?? '', type: a?.type ?? (liabilityDefault ? 'credit_card' : 'checking'),
    institution: a?.institution ?? '', is_liability: a?.is_liability ?? !!liabilityDefault,
    account_number: a?.account_number ?? '', username: a?.username ?? '',
    interest_rate: a?.interest_rate?.toString() ?? '',
    opened_date: a?.opened_date?.slice(0, 10) ?? '',
    owner: a?.owner ?? '', owner_user_id: a?.owner_user_id?.toString() ?? '', ownership_type: a?.ownership_type ?? 'individual',
    has_beneficiaries: a?.has_beneficiaries ?? false, is_retirement: a?.is_retirement ?? false,
    is_card: a?.is_card ?? false, is_loan: a?.is_loan ?? false,
    login_url: a?.login_url ?? '', website_url: a?.website_url ?? '', phone: a?.phone ?? '', notes: a?.notes ?? '',
  });
  const [f, setF] = useState(() => seedOf(account));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seedOf(account)));
  useEffect(() => { const s = seedOf(account); setF(s); setSavedJson(JSON.stringify(s)); }, [account?.id]);
  const dirty = JSON.stringify(f) !== savedJson;
  // Preview capability-tab visibility live as the toggles change.
  useEffect(() => { onCapsChange?.({ beneficiaries: f.has_beneficiaries, retirement: f.is_retirement, card: f.is_card, loan: f.is_loan }); },
    [f.has_beneficiaries, f.is_retirement, f.is_card, f.is_loan]);
  // Selecting a type turns on the capabilities that type usually needs (never off).
  const capsForType = (t: string) => ({
    has_beneficiaries: f.has_beneficiaries || ['retirement', '529', 'hsa', 'fsa', 'brokerage', 'investment', 'cd'].includes(t),
    is_retirement: f.is_retirement || t === 'retirement',
    is_card: f.is_card || t === 'credit_card',
    is_loan: f.is_loan || ['loan', 'mortgage'].includes(t),
  });

  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const num = (s: string) => (s === '' ? null : Number(s));
  const balanceLabel = f.is_liability ? 'Balance owed' : 'Balance';
  const OpenBtn = ({ value }: { value: string }) => (
    <button type="button" className="ghost" disabled={!isOpenableUrl(value)}
      onClick={() => { const u = normalizeUrl(value); if (u) window.open(u, '_blank', 'noopener'); }}
      style={{ whiteSpace: 'nowrap' }}>Open</button>
  );

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name, type: f.type, institution: f.institution || null, is_liability: f.is_liability,
      account_number: f.account_number || null, username: f.username || null,
      interest_rate: num(f.interest_rate),
      opened_date: f.opened_date || null, notes: f.notes || null,
      owner: f.owner.trim() || null, owner_user_id: f.owner_user_id ? Number(f.owner_user_id) : null, ownership_type: f.ownership_type || null,
      has_beneficiaries: f.has_beneficiaries, is_retirement: f.is_retirement, is_card: f.is_card, is_loan: f.is_loan,
      login_url: f.login_url.trim() || null, website_url: f.website_url.trim() || null, phone: f.phone.trim() || null,
    };
    try {
      const a = isNew ? (await api.post<Account>('/accounts', body)) : (await api.put<Account>(`/accounts/${account!.id}`, body));
      setSavedJson(JSON.stringify(f));
      onSaved(a);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!account || !confirm(`Delete account "${account.name}"? Its balance history is removed and its transactions are kept but unlinked.`)) return;
    try { await api.del(`/accounts/${account.id}`); onDeleted?.(); } catch (e: any) { setErr(e.message); }
  };

  void balanceLabel;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>{isNew ? (f.is_liability ? 'New liability' : 'New account') : 'Account details'}</div>
        <div className="btn-row">
          {!isNew && onDeleted && <button className="danger" onClick={remove}>Delete</button>}
          <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : isNew ? 'Add account' : 'Save changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <Section title="Account Summary" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-2">
            <Field label="Account Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Everyday Checking" /></Field>
            <Field label="Institution"><input value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} placeholder="e.g. Chase" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Account Type">
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, is_liability: account ? f.is_liability : LIABILITY_ACCOUNT_TYPES.includes(e.target.value), ...capsForType(e.target.value) })}>
                {ACCOUNT_TYPES.filter(([v]) => !typeFilter || (typeFilter === 'liability' ? LIABILITY_ACCOUNT_TYPES.includes(v) : !LIABILITY_ACCOUNT_TYPES.includes(v))).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </Field>
            {!typeFilter && (
              <div style={{ marginBottom: 12 }}>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-soft)', marginBottom: 4, fontWeight: 500 }}>Account Treatment</span>
                <label className={`check-card${f.is_liability ? ' on' : ''}`}>
                  <input type="checkbox" checked={f.is_liability} onChange={(e) => setF({ ...f, is_liability: e.target.checked })} />
                  <span className="check-body">
                    <span className="check-title">This is a liability account</span>
                    <span className="check-help">Balances for this account subtract from net worth.</span>
                  </span>
                </label>
              </div>
            )}
          </div>

          <EditorSection title="Owner" />
          <div className="grid grid-3">
            <Field label="Owner Name"><input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} placeholder="Whose account this is" /></Field>
            <Field label="Linked Member">
              <select value={f.owner_user_id} onChange={(e) => { const m = members.find((x) => String(x.id) === e.target.value); setF({ ...f, owner_user_id: e.target.value, owner: m ? (m.name || m.email) : f.owner }); }}>
                <option value="">— Not linked —</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
              </select>
            </Field>
            <Field label="Ownership Type">
              <select value={f.ownership_type} onChange={(e) => setF({ ...f, ownership_type: e.target.value })}>
                {OWNERSHIP_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-3">
            <Field label="Account Number / Last 4"><input value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} placeholder="Last 4 recommended" /></Field>
            <Field label="Account Opened (at the Bank)"><input type="date" value={f.opened_date} onChange={(e) => setF({ ...f, opened_date: e.target.value })} /></Field>
            <Field label="Interest Rate / APR (%)"><input className="num-input" inputMode="decimal" value={f.interest_rate} onChange={(e) => setF({ ...f, interest_rate: e.target.value })} placeholder="e.g. 4.25" /></Field>
          </div>

          <EditorSection title="Notes" />
          <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Anything worth remembering about this account" /></Field>
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="What This Account Tracks" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Turn on the details this account needs — each adds a dedicated tab.</div>
          <div className="grid grid-2">
            {([
              ['has_beneficiaries', 'Track beneficiaries', 'Who inherits this account (retirement, HSA, brokerage).', false],
              ['is_retirement', 'Track retirement details', 'Plan type, custodian, contributions, vesting.', false],
              ['is_card', 'Track credit-card details', 'Credit limit, statement day, rewards, fees.', true],
              ['is_loan', 'Track loan details', 'Principal, term, payment, payoff, escrow.', true],
            ] as [keyof typeof f, string, string, boolean][])
              .filter(([, , , forLiability]) => forLiability === f.is_liability)
              .map(([key, title, help]) => (
              <label key={key} className={`check-card${f[key] ? ' on' : ''}`}>
                <input type="checkbox" checked={!!f[key]} onChange={(e) => setF({ ...f, [key]: e.target.checked })} />
                <span className="check-body"><span className="check-title">{title}</span><span className="check-help">{help}</span></span>
              </label>
            ))}
          </div>
          {isNew && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>After saving, fill in each tab's details and record a balance snapshot from a statement.</div>}
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="Online Access" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-2">
            <Field label="Web Address">
              <div className="row" style={{ gap: 8 }}>
                <input value={f.website_url} onChange={(e) => setF({ ...f, website_url: e.target.value })} placeholder="e.g. chase.com" style={{ flex: 1 }} />
                <OpenBtn value={f.website_url} />
              </div>
            </Field>
            <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} onBlur={(e) => setF({ ...f, phone: formatPhone(e.target.value) })} placeholder="e.g. (800) 555-0100" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Login URL">
              <div className="row" style={{ gap: 8 }}>
                <input value={f.login_url} onChange={(e) => setF({ ...f, login_url: e.target.value })} placeholder="e.g. chase.com/login" style={{ flex: 1 }} />
                <OpenBtn value={f.login_url} />
              </div>
            </Field>
            <Field label="Login ID"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="username or email" /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>The bank's site and the portal where you sign in. Stored for quick access — don't keep your password here.</div>
        </Section>
      </div>
    </>
  );
}

// --- Capability tab forms (Retirement / Card / Loan) -------------------------
// Each edits a focused set of account columns via a partial PUT, so saving one
// capability never disturbs another's fields.
type CapField = { col: string; label: string; type: 'text' | 'amount' | 'number' | 'date' | 'select' | 'check'; options?: [string, string][]; placeholder?: string };

const RETIREMENT_FIELDS: CapField[] = [
  { col: 'retirement_plan_kind', label: 'Plan Type', type: 'select', options: [['', '—'], ['traditional_ira', 'Traditional IRA'], ['roth_ira', 'Roth IRA'], ['401k', '401(k)'], ['roth_401k', 'Roth 401(k)'], ['403b', '403(b)'], ['457b', '457(b)'], ['sep_ira', 'SEP IRA'], ['simple_ira', 'SIMPLE IRA'], ['pension', 'Pension'], ['other', 'Other']] },
  { col: 'retirement_tax_treatment', label: 'Tax Treatment', type: 'select', options: [['', '—'], ['pretax', 'Pre-tax'], ['roth', 'Roth'], ['after_tax', 'After-tax']] },
  { col: 'retirement_custodian', label: 'Custodian', type: 'text', placeholder: 'e.g. Fidelity' },
  { col: 'retirement_employer', label: 'Employer', type: 'text' },
  { col: 'retirement_contribution_ytd', label: 'Contributions YTD', type: 'amount' },
  { col: 'retirement_employer_match', label: 'Employer Match', type: 'text', placeholder: 'e.g. 100% up to 4%' },
  { col: 'retirement_vesting_pct', label: 'Vesting (%)', type: 'number', placeholder: 'e.g. 100' },
  { col: 'retirement_rmd_applicable', label: 'Required Minimum Distributions apply', type: 'check' },
];

const CARD_FIELDS: CapField[] = [
  { col: 'credit_limit', label: 'Credit Limit', type: 'amount' },
  { col: 'card_statement_day', label: 'Statement Close Day', type: 'number', placeholder: '1–31' },
  { col: 'due_day', label: 'Payment Due Day', type: 'number', placeholder: '1–31' },
  { col: 'card_min_payment', label: 'Minimum Payment', type: 'amount' },
  { col: 'card_annual_fee', label: 'Annual Fee', type: 'amount' },
  { col: 'card_rewards_program', label: 'Rewards Program', type: 'text', placeholder: 'e.g. 2% cash back' },
  { col: 'card_points_balance', label: 'Points / Miles Balance', type: 'number' },
];

const LOAN_FIELDS: CapField[] = [
  { col: 'loan_original_principal', label: 'Original Principal', type: 'amount' },
  { col: 'loan_term_months', label: 'Term (Months)', type: 'number', placeholder: 'e.g. 360' },
  { col: 'loan_payment_amount', label: 'Payment Amount', type: 'amount' },
  { col: 'loan_payment_frequency', label: 'Payment Frequency', type: 'select', options: [['monthly', 'Monthly'], ['biweekly', 'Bi-Weekly'], ['weekly', 'Weekly']] },
  { col: 'due_day', label: 'Payment Due Day', type: 'number', placeholder: '1–31' },
  { col: 'loan_origination_date', label: 'Origination Date', type: 'date' },
  { col: 'loan_payoff_date', label: 'Payoff / Maturity Date', type: 'date' },
  { col: 'loan_escrow_amount', label: 'Escrow Amount', type: 'amount' },
  { col: 'loan_lien_holder', label: 'Lien Holder', type: 'text' },
];

function CapabilityForm({ account, fields, title, onSaved }: { account: Account; fields: CapField[]; title: string; onSaved: () => void }) {
  const seed = () => Object.fromEntries(fields.map((fl) => {
    const v = (account as any)[fl.col];
    return [fl.col, fl.type === 'check' ? !!v : v == null ? '' : fl.type === 'date' ? String(v).slice(0, 10) : String(v)];
  }));
  const [f, setF] = useState<Record<string, any>>(seed);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seed()));
  useEffect(() => { const s = seed(); setF(s); setSavedJson(JSON.stringify(s)); }, [account.id]);
  const dirty = JSON.stringify(f) !== savedJson;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const numv = (s: any) => (s === '' || s == null ? null : Number(s));

  const save = async () => {
    setSaving(true); setErr('');
    const body: any = {};
    for (const fl of fields) {
      const v = f[fl.col];
      body[fl.col] = fl.type === 'check' ? !!v : (fl.type === 'amount' || fl.type === 'number') ? numv(v) : (v || null);
    }
    try { await api.put(`/accounts/${account.id}`, body); setSavedJson(JSON.stringify(f)); onSaved(); }
    catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>{title} Details</div>
        <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="grid grid-2">
        {fields.map((fl) => (
          <Field key={fl.col} label={fl.label}>
            {fl.type === 'select' ? (
              <select value={f[fl.col]} onChange={(e) => setF({ ...f, [fl.col]: e.target.value })}>
                {fl.options!.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            ) : fl.type === 'amount' ? (
              <AmountInput value={f[fl.col]} onChange={(v) => setF({ ...f, [fl.col]: v })} placeholder={fl.placeholder ?? '0.00'} />
            ) : fl.type === 'date' ? (
              <input type="date" value={f[fl.col]} onChange={(e) => setF({ ...f, [fl.col]: e.target.value })} />
            ) : fl.type === 'check' ? (
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!f[fl.col]} onChange={(e) => setF({ ...f, [fl.col]: e.target.checked })} />
                <span className="muted" style={{ fontSize: 13 }}>Yes</span>
              </label>
            ) : (
              <input className={fl.type === 'number' ? 'num-input' : ''} inputMode={fl.type === 'number' ? 'decimal' : undefined} value={f[fl.col]} onChange={(e) => setF({ ...f, [fl.col]: e.target.value })} placeholder={fl.placeholder} />
            )}
          </Field>
        ))}
      </div>
    </div>
  );
}
