import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate, todayStr, ACCOUNT_TYPES, accountTypeLabel, LIABILITY_ACCOUNT_TYPES, isHttpUrl, normalizeUrl } from '../api';
import { Field, Modal, DragHandle, arrayMove, slotReorder, CHART_COLORS, chartTooltip, EditorFooter, AmountInput, FormSection } from '../components/ui';

export interface Account {
  id: number;
  name: string;
  type: string;
  institution: string | null;
  is_liability: boolean;
  posted_balance: number | null;
  pending_balance: number | null;
  opening_balance: number | null;
  opening_date: string | null;
  account_number: string | null;
  interest_rate: number | null;
  credit_limit: number | null;
  due_day: number | null;
  username: string | null;
  beneficiaries: string | null;
  opened_date: string | null;
  login_url: string | null;
  website_url: string | null;
  phone: string | null;
  notes: string | null;
  // Owner + capability flags (migration 094).
  owner: string | null;
  owner_user_id: number | null;
  ownership_type: string | null;
  has_beneficiaries: boolean;
  is_retirement: boolean;
  is_card: boolean;
  is_loan: boolean;
  // Retirement capability.
  retirement_plan_kind: string | null;
  retirement_custodian: string | null;
  retirement_employer: string | null;
  retirement_contribution_ytd: number | null;
  retirement_employer_match: string | null;
  retirement_vesting_pct: number | null;
  retirement_tax_treatment: string | null;
  retirement_rmd_applicable: boolean | null;
  // Card capability.
  card_statement_day: number | null;
  card_min_payment: number | null;
  card_rewards_program: string | null;
  card_points_balance: number | null;
  card_annual_fee: number | null;
  // Loan capability.
  loan_original_principal: number | null;
  loan_term_months: number | null;
  loan_payment_amount: number | null;
  loan_payment_frequency: string | null;
  loan_origination_date: string | null;
  loan_payoff_date: string | null;
  loan_escrow_amount: number | null;
  loan_lien_holder: string | null;
  // Lifecycle + import status (migration 056).
  archived_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  status?: 'active' | 'archived' | 'closed';
  import_provider?: string | null;
  last_import_at?: string | null;
  last_import_status?: string | null;
  last_import_error?: string | null;
  // Linked to an automatic-import connection (SimpleFIN).
  auto_synced?: boolean;
  sync_provider?: string | null;
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Fine-grained type → label buckets used by the "by type" pie charts only.
const ACCOUNT_GROUPS: { key: string; label: string; types: string[]; liability?: boolean }[] = [
  { key: 'cash', label: 'Cash', types: ['checking', 'savings', 'cash', 'money_market', 'cd'] },
  { key: 'credit', label: 'Credit Cards', types: ['credit_card'], liability: true },
  { key: 'investments', label: 'Investments', types: ['investment', 'retirement', '529', 'brokerage'] },
  { key: 'loans', label: 'Loans', types: ['loan', 'mortgage'], liability: true },
  { key: 'health', label: 'Health (HSA / FSA)', types: ['hsa', 'fsa'] },
  { key: 'other', label: 'Other', types: ['asset', 'other'] },
];

// Broad display groups for the Account list (in render order). An account keeps
// its specific `type` (still shown on the row); this only decides which card it
// appears under. Ambiguous generic types ('asset'/'other') are intentionally left
// out so they fall through to the is_liability rule in getAccountDisplayGroup.
// Centralized here so the mapping can be tuned later.
const DISPLAY_GROUPS: { key: string; label: string; liability: boolean; types: string[] }[] = [
  { key: 'cash', label: 'Cash & Banking', liability: false, types: ['checking', 'savings', 'cash', 'money_market', 'cd', 'hsa', 'fsa'] },
  { key: 'investments', label: 'Investments', liability: false, types: ['investment', 'brokerage', 'retirement', '529', 'crypto'] },
  { key: 'assets', label: 'Property & Assets', liability: false, types: ['property', 'real_estate', 'vehicle', 'collectible'] },
  { key: 'credit', label: 'Credit Cards', liability: true, types: ['credit_card'] },
  { key: 'mortgages', label: 'Mortgages', liability: true, types: ['mortgage'] },
  { key: 'loans', label: 'Loans', liability: true, types: ['loan'] },
];
// Map an account to its broad display group. Match by type first; for unmatched
// types, liabilities fall back to Loans and everything else to Property & assets.
export const getAccountDisplayGroup = (a: { type: string; is_liability: boolean }): string =>
  DISPLAY_GROUPS.find((g) => g.types.includes(a.type))?.key ?? (a.is_liability ? 'loans' : 'assets');
// Human label for an account's broad display group (e.g. "Cash & banking").
export const accountGroupLabel = (a: { type: string; is_liability: boolean }): string =>
  DISPLAY_GROUPS.find((g) => g.key === getAccountDisplayGroup(a))?.label ?? '';
const acctCount = (n: number) => `${n} account${n === 1 ? '' : 's'}`;

// How many balance snapshots to show inline in the editor; the rest are behind "View all".
const SNAP_PREVIEW = 10;
const ANCHOR_TIP = 'This snapshot is the starting point used to calculate the current account balance.';

export default function Accounts({ treatment }: { treatment?: 'asset' | 'liability' } = {}) {
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  // Scope to asset (non-liability) or liability accounts when the page is opened
  // as the "Asset Accounts" / "Liability Accounts" nav view; otherwise show all.
  const accounts = useMemo(
    () => (treatment ? allAccounts.filter((a) => (treatment === 'liability' ? a.is_liability : !a.is_liability)) : allAccounts),
    [allAccounts, treatment]
  );
  const [drag, setDrag] = useState<{ group: string; idx: number } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  // Inactive (archived or closed) accounts live in one collapsible section at the
  // bottom (mirrors the "Show" pattern on the other modules); the pref persists.
  const [showInactive, setShowInactive] = useState(() => localStorage.getItem('accounts.showInactive') === '1');
  const toggleInactive = () => setShowInactive((v) => { localStorage.setItem('accounts.showInactive', v ? '0' : '1'); return !v; });
  const [err, setErr] = useState('');
  // Charts can be hidden; the preference persists across visits.
  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('accounts.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('accounts.hideCharts', v ? '1' : '0'); return !v; });
  const location = useLocation();
  const navigate = useNavigate();

  const load = () => api.get<Account[]>('/accounts').then(setAllAccounts).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Active accounts drive the lists/totals/charts. Archived and closed accounts are
  // pulled out into a single "Inactive Accounts" collapsible at the bottom. Nothing
  // is deleted — their transactions still show everywhere. (A future-dated close
  // keeps the account active until its date via the server's status field.)
  const visible = useMemo(() => accounts.filter((a) => (a.status ?? 'active') === 'active'), [accounts]);
  const inactiveAccounts = useMemo(() => accounts.filter((a) => (a.status ?? 'active') !== 'active'), [accounts]);

  // Top-of-page summary: totals and balances-by-type charts. Round each total to
  // cents and derive Net from the rounded figures so the three cards always
  // reconcile (raw float sums can otherwise round inconsistently, making it look
  // like Net ≠ Assets − Liabilities).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const assetsTotal = round2(visible.filter((a) => !a.is_liability).reduce((s, a) => s + Number(a.posted_balance ?? 0), 0));
  const liabsTotal = round2(visible.filter((a) => a.is_liability).reduce((s, a) => s + Number(a.posted_balance ?? 0), 0));
  const netTotal = round2(assetsTotal - liabsTotal);
  const sumBalances = (filter: (a: Account) => boolean) => round2(visible.filter(filter).reduce((s, a) => s + Number(a.posted_balance ?? 0), 0));
  // Asset-view tiles: cash vs. invested split.
  const cashTotal = sumBalances((a) => getAccountDisplayGroup(a) === 'cash');
  const investTotal = sumBalances((a) => getAccountDisplayGroup(a) === 'investments');
  // Liability-view tiles: credit-card limit/availability/utilization.
  const cards = visible.filter((a) => a.type === 'credit_card');
  const cardLimit = cards.reduce((s, a) => s + Number(a.credit_limit ?? 0), 0);
  const cardBalance = cards.reduce((s, a) => s + Number(a.posted_balance ?? 0), 0);
  const cardAvailable = round2(cardLimit - cardBalance);
  const cardUtil = cardLimit > 0 ? Math.round((cardBalance / cardLimit) * 100) : null;
  // Balances grouped by account-type group, for the pie charts. `liability`
  // selects which side (assets vs debts) to bucket.
  const byTypeFor = (liability: boolean) => {
    const m = new Map<string, number>();
    for (const a of visible) {
      if (a.is_liability !== liability) continue;
      const label = ACCOUNT_GROUPS.find((g) => g.types.includes(a.type))?.label ?? 'Other';
      m.set(label, (m.get(label) ?? 0) + Number(a.posted_balance ?? 0));
    }
    return [...m.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  };
  // Per-account balances for the bar charts, split by side.
  const byAccountFor = (liability: boolean) =>
    visible.filter((a) => a.is_liability === liability)
      .map((a) => ({ name: a.name, value: Math.round(Number(a.posted_balance ?? 0) * 100) / 100 }))
      .filter((x) => x.value !== 0).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const assetsByType = useMemo(() => byTypeFor(false), [visible]);
  const liabsByType = useMemo(() => byTypeFor(true), [visible]);
  const assetsByAccount = useMemo(() => byAccountFor(false), [visible]);
  const liabsByAccount = useMemo(() => byAccountFor(true), [visible]);
  const hasAssetCharts = assetsByType.length > 0 || assetsByAccount.length > 0;
  const hasLiabCharts = liabsByType.length > 0 || liabsByAccount.length > 0;

  // Drag-to-reorder within a type group; persist the full account order.
  const reorder = async (rows: Account[], from: number, to: number) => {
    if (from === to) return;
    const displayed = rows.map((a) => a.id);
    const next = arrayMove(displayed, from, to);
    try { await api.post('/accounts/reorder', { ids: slotReorder(accounts.map((a) => a.id), displayed, next) }); load(); } catch (e: any) { setErr(e.message); }
  };

  // Allow other pages (Asset/Liability dashboards) to deep-link into the add flow.
  useEffect(() => {
    const st = location.state as { add?: boolean; liability?: boolean } | null;
    if (st?.add) {
      navigate(st.liability ? '/accounts/new?liability=1' : '/accounts/new', { replace: true, state: null });
    }
  }, [location, navigate]);

  // Chart renderers, shared by the assets row and the liabilities row so both
  // sides look identical. Plain functions (not components) so they inline without
  // remounting/re-animating the charts on every render.
  const renderTypePie = (data: { label: string; value: number }[], total: number) => (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={52} outerRadius={84} paddingAngle={2} stroke="none">
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            <Label position="center" value={money(total)} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 600, fill: '#23262B' }} />
          </Pie>
          <Tooltip formatter={(v: number) => money(v)} contentStyle={chartTooltip} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} formatter={(value, entry: any) => `${value} · ${money(entry?.payload?.value ?? 0)}`} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
  const renderAccountBars = (data: { name: string; value: number }[], fill: string, valueName: string) => (
    <div style={{ height: Math.max(240, data.length * 30) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + v} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
          <Tooltip formatter={(v: number) => [money(v), valueName]} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} fill={fill} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{treatment === 'liability' ? 'Liabilities' : treatment === 'asset' ? 'Assets' : 'Accounts'}</div>
          <h1 className="title">{treatment === 'liability' ? 'Liability Accounts' : treatment === 'asset' ? 'Asset Accounts' : 'Accounts'}</h1>
          <p className="subtitle">
            {treatment === 'liability'
              ? 'Credit cards, loans, and mortgages — balances you owe, counted against net worth.'
              : treatment === 'asset'
                ? 'Cash, savings, investment, and retirement accounts — what you own.'
                : 'Your accounts grouped by type. Balances are calculated from snapshots and transactions, with pending shown when it differs.'}
          </p>
        </div>
        <button className="head-add" onClick={() => navigate(treatment ? `/accounts/new?treatment=${treatment}` : '/accounts/new')}>Add Account</button>
      </div>

      {(hasAssetCharts || hasLiabCharts || accounts.length > 0) && (
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8, marginBottom: 16 }}>
          {(hasAssetCharts || hasLiabCharts) && (
            <button className="ghost" onClick={toggleCharts}>{showCharts ? 'Hide Charts' : 'Show Charts'}</button>
          )}
          {accounts.length > 0 && <button className="ghost" onClick={() => setBulkOpen(true)}>Update Balances</button>}
        </div>
      )}

      {err && <div className="error">{err}</div>}

      {accounts.length > 0 && (
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          {treatment === 'asset' ? (
            <>
              <div className="card stat"><div className="label">Total Value</div><div className="value">{money(assetsTotal)}</div><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{acctCount(visible.length)}</div></div>
              <div className="card stat"><div className="label">Cash &amp; Banking</div><div className="value small">{money(cashTotal)}</div></div>
              <div className="card stat"><div className="label">Investments</div><div className="value small">{money(investTotal)}</div></div>
            </>
          ) : treatment === 'liability' ? (
            <>
              <div className="card stat"><div className="label">Total Owed</div><div className="value debit">{money(liabsTotal)}</div><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{acctCount(visible.length)}</div></div>
              <div className="card stat"><div className="label">Available Credit</div><div className="value small">{cardLimit > 0 ? money(cardAvailable) : '—'}</div>{cardLimit > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>of {money(cardLimit)} limit</div>}</div>
              <div className="card stat"><div className="label">Credit Used</div><div className={`value small ${cardUtil != null && cardUtil >= 70 ? 'debit' : ''}`}>{cardUtil != null ? `${cardUtil}%` : '—'}</div></div>
            </>
          ) : (
            <>
              <div className="card stat"><div className="label">Assets</div><div className="value">{money(assetsTotal)}</div></div>
              <div className="card stat"><div className="label">Debt / liabilities</div><div className="value debit">{money(liabsTotal)}</div><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>owed</div></div>
              <div className="card stat"><div className="label">Net account value</div><div className={`value ${netTotal < 0 ? 'debit' : ''}`}>{money(netTotal)}</div></div>
            </>
          )}
        </div>
      )}

      {showCharts && hasAssetCharts && (
        <div className="grid grid-2" style={{ marginBottom: 18 }}>
          {assetsByType.length > 0 && (
            <div className="card">
              <div className="label" style={{ marginBottom: 8 }}>Assets by type</div>
              {renderTypePie(assetsByType, assetsTotal)}
            </div>
          )}
          {assetsByAccount.length > 0 && (
            <div className="card">
              <div className="label" style={{ marginBottom: 8 }}>Asset balances</div>
              {renderAccountBars(assetsByAccount, '#5A6F87', 'balance')}
            </div>
          )}
        </div>
      )}

      {showCharts && hasLiabCharts && (
        <div className="grid grid-2" style={{ marginBottom: 18 }}>
          {liabsByType.length > 0 && (
            <div className="card">
              <div className="label" style={{ marginBottom: 8 }}>Liabilities by type</div>
              {renderTypePie(liabsByType, liabsTotal)}
            </div>
          )}
          {liabsByAccount.length > 0 && (
            <div className="card">
              <div style={{ marginBottom: 8 }}>
                <div className="label">Debt balances</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Shown as amounts owed.</div>
              </div>
              {renderAccountBars(liabsByAccount, '#A15648', 'owed')}
            </div>
          )}
        </div>
      )}

      <div style={{ margin: '20px 0 10px' }}>
        <h2 className="section" style={{ margin: 0 }}>Account List</h2>
        {accounts.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {acctCount(visible.length)} · {money(assetsTotal)} assets · {money(liabsTotal)} owed
          </div>
        )}
      </div>

      {accounts.length === 0 ? (
        <div className="card"><div className="empty">No accounts yet. Add one to start tracking.</div></div>
      ) : (
        <div>
          {DISPLAY_GROUPS.map((g) => {
            const rows = visible.filter((a) => getAccountDisplayGroup(a) === g.key);
            if (rows.length === 0) return null;
            const total = rows.reduce((s, a) => s + Number(a.posted_balance ?? 0), 0);
            // Credit availability is a credit-card concept: scope it to credit cards
            // so other debts (e.g. mortgages) in the group don't distort it.
            const creditRows = rows.filter((a) => a.type === 'credit_card');
            const creditLimit = creditRows.reduce((s, a) => s + Number(a.credit_limit ?? 0), 0);
            const creditBalance = creditRows.reduce((s, a) => s + Number(a.posted_balance ?? 0), 0);
            const available = creditLimit - creditBalance;
            return (
              <div key={g.key}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', margin: '20px 0 10px' }}>
                  <div>
                    <h2 className="section" style={{ margin: 0 }}>{g.label}</h2>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{acctCount(rows.length)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div>
                      <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>{g.liability ? 'Owed' : 'Total'}</span>
                      <span className={`num ${g.liability ? 'debit' : ''}`} style={{ fontSize: 17, fontWeight: 600 }}>{money(total)}</span>
                    </div>
                    {g.key === 'credit' && creditLimit > 0 && (
                      <div className="muted num" style={{ fontSize: 12, marginTop: 2 }}>
                        {money(available)} available of {money(creditLimit)} credit limit
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 16 }}>
                  {rows.map((a, i) => {
                    const pendingDiffers = Number(a.pending_balance ?? 0) !== Number(a.posted_balance ?? 0);
                    const subtitle = [accountTypeLabel(a.type), a.institution].filter(Boolean).join(' · ');
                    // Numeric stat tiles, mirroring the Properties card's 3-up grid.
                    const stats: { label: string; value: string; cls: string }[] = [
                      { label: a.is_liability ? 'Owed' : 'Balance', value: money(a.posted_balance), cls: a.is_liability ? 'debit' : '' },
                      { label: 'Pending', value: pendingDiffers ? money(a.pending_balance) : '—', cls: pendingDiffers ? (a.is_liability ? 'debit' : '') : 'muted' },
                    ];
                    if (a.type === 'credit_card' && a.credit_limit != null) {
                      stats.push({ label: 'Available', value: money(a.credit_limit - Number(a.posted_balance ?? 0)), cls: '' });
                    } else if (a.interest_rate != null) {
                      stats.push({ label: 'Interest / APR', value: `${a.interest_rate}%`, cls: '' });
                    }
                    // Read-only facts, shown as label/value rows like the Properties card.
                    const facts: [string, string][] = [];
                    if (a.account_number) facts.push(['Account #', `••${a.account_number.slice(-4)}`]);
                    if (a.due_day != null) facts.push(['Payment due', ordinal(a.due_day)]);
                    if (a.beneficiaries) facts.push(['Beneficiaries', a.beneficiaries]);
                    return (
                      <div key={a.id}
                        className={`card kindcard ${a.is_liability ? 'expense' : 'income'} clickable`}
                        style={{ cursor: 'pointer', ...(drag && drag.group === g.key && drag.idx === i ? { opacity: 0.5 } : {}) }}
                        onClick={() => navigate(`/accounts/${a.id}`)}
                        onDragOver={(e) => { if (drag && drag.group === g.key) e.preventDefault(); }}
                        onDrop={() => { if (drag && drag.group === g.key && drag.idx !== i) reorder(rows, drag.idx, i); setDrag(null); }}
                        title="View account details">
                        <div className="kindcard-head">
                          <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                            <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                              <DragHandle index={i} onStart={(idx) => setDrag({ group: g.key, idx })} onEnd={() => setDrag(null)} />
                            </span>
                            <div style={{ minWidth: 0 }}>
                              <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                {a.name}
                                {a.closed_at ? <span className="tag" style={{ fontSize: 11, color: 'var(--debit)', borderColor: 'var(--debit)' }}>Closes {shortDate(a.closed_at)}</span> : null}
                                {isHttpUrl(normalizeUrl(a.login_url)) && (
                                  <a className="tag" href={normalizeUrl(a.login_url)!} target="_blank" rel="noopener noreferrer" title="Open bank login"
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ fontSize: 11, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--brass-deep)', borderColor: 'var(--brass)' }}>Login ↗</a>
                                )}
                              </div>
                              {subtitle && <div className="muted" style={{ fontSize: 12 }}>{subtitle}</div>}
                            </div>
                          </div>
                          <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/accounts/${a.id}`); }}>View Details →</button>
                        </div>

                        <div style={{ padding: '12px 14px' }}>
                          <div className="grid grid-3" style={{ marginBottom: (facts.length || a.notes) ? 8 : 0 }}>
                            {stats.map((s) => (
                              <div key={s.label} className="stat"><div className="label">{s.label}</div><div className={`value small ${s.cls}`}>{s.value}</div></div>
                            ))}
                          </div>
                          {facts.map(([k, v]) => (
                            <div key={k} className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                              <span className="muted">{k}</span><span className="num">{v}</span>
                            </div>
                          ))}
                          {a.notes && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{a.notes}</div>}
                          <div className="muted" style={{ fontSize: 12, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
                            Click to view details and edit.
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {inactiveAccounts.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '22px 0 8px' }}>
            <div className="label" style={{ margin: 0 }}>Inactive Accounts · {inactiveAccounts.length}</div>
            <button className="ghost" onClick={toggleInactive}>{showInactive ? 'Hide' : 'Show'}</button>
          </div>
          {showInactive && (
            <div style={{ display: 'grid', gap: 16 }}>
              {inactiveAccounts.map((a) => {
                const subtitle = [accountTypeLabel(a.type), a.institution].filter(Boolean).join(' · ');
                const isClosed = a.status === 'closed';
                return (
                  <div key={a.id} className={`card kindcard ${a.is_liability ? 'expense' : 'income'} clickable`}
                    style={{ cursor: 'pointer', opacity: 0.8 }}
                    onClick={() => navigate(`/accounts/${a.id}`)} title="View account details">
                    <div className="kindcard-head">
                      <div style={{ minWidth: 0 }}>
                        <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {a.name}
                          <span className="tag" style={{ fontSize: 11 }}>{isClosed ? 'Closed' : 'Archived'}</span>
                        </div>
                        {subtitle && <div className="muted" style={{ fontSize: 12 }}>{subtitle}</div>}
                      </div>
                      <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/accounts/${a.id}`); }}>View Details →</button>
                    </div>
                    <div style={{ padding: '12px 14px' }}>
                      <div className="grid grid-3">
                        <div className="stat"><div className="label">{a.is_liability ? 'Owed' : 'Balance'}</div><div className={`value small ${a.is_liability ? 'debit' : ''}`}>{money(a.posted_balance)}</div></div>
                        <div className="stat"><div className="label">{isClosed ? 'Closed' : 'Archived'}</div><div className="value small">{isClosed ? (a.closed_at ? shortDate(a.closed_at) : '—') : (a.archived_at ? shortDate(a.archived_at) : '—')}</div></div>
                        <div className="stat"><div className="label">Reason</div><div className="value small">{a.close_reason || '—'}</div></div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {bulkOpen && (
        <BulkSnapshot accounts={accounts} onClose={() => setBulkOpen(false)} onSaved={() => { setBulkOpen(false); load(); }} />
      )}
    </>
  );
}

// Bulk weekly balance update: pick a date, enter each account's balance, and
// record a snapshot per account in one go.
function BulkSnapshot({ accounts, onClose, onSaved }: { accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [asOf, setAsOf] = useState(todayStr());
  const [vals, setVals] = useState<Record<number, string>>(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.posted_balance != null ? String(a.posted_balance) : '']))
  );
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!asOf) { setErr('Pick a date.'); return; }
    const entries = accounts.filter((a) => { const v = vals[a.id]; return v != null && v !== '' && !Number.isNaN(Number(v)); });
    if (entries.length === 0) { setErr('Enter at least one balance.'); return; }
    setSaving(true);
    try {
      await Promise.all(entries.map((a) => api.post(`/accounts/${a.id}/balances`, { as_of: asOf, balance: Number(vals[a.id]) })));
      onSaved();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };
  return (
    <Modal title="Update Balances" onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="row" style={{ gap: 12, alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
        <Field label="As of Date"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <div className="muted" style={{ fontSize: 12, flex: 1, minWidth: 220 }}>
          Records a balance snapshot on this date for each account (prefilled with the current value). Clear a field to skip that account.
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="ledger">
          <thead><tr><th>Account</th><th>Type</th><th className="r">Balance on {asOf ? shortDate(asOf) : 'date'}</th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}{a.is_liability && <span className="muted" style={{ fontSize: 11 }}> · owed</span>}</td>
                <td className="muted">{accountTypeLabel(a.type)}</td>
                <td className="r">
                  <AmountInput value={vals[a.id] ?? ''} placeholder="skip"
                    style={{ width: 130, textAlign: 'right' }}
                    onChange={(v) => setVals({ ...vals, [a.id]: v })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>Close</button>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save snapshots'}</button>
      </div>
    </Modal>
  );
}

interface Snapshot { id: number; as_of: string; balance: number }

export function AccountEditor({ account, liability = false, onClose, onSaved, onDeleted, onChanged }: {
  account: Account | null; liability?: boolean;
  onClose: () => void; onSaved: () => void; onDeleted: () => void; onChanged: () => void;
}) {
  const [f, setF] = useState({
    name: account?.name ?? '',
    type: account?.type ?? (liability ? 'credit_card' : 'checking'),
    institution: account?.institution ?? '',
    is_liability: account?.is_liability ?? liability,
    account_number: account?.account_number ?? '',
    username: account?.username ?? '',
    interest_rate: account?.interest_rate?.toString() ?? '',
    credit_limit: account?.credit_limit?.toString() ?? '',
    due_day: account?.due_day?.toString() ?? '',
    opened_date: account?.opened_date?.slice(0, 10) ?? '',
    beneficiaries: account?.beneficiaries ?? '',
    login_url: account?.login_url ?? '',
    notes: account?.notes ?? '',
  });
  const [err, setErr] = useState('');
  const num = (s: string) => (s === '' ? null : Number(s));

  // Enable Save only once something changes from the loaded state.
  const baseline = useRef<string | null>(null);
  const snapshot = JSON.stringify(f);
  if (baseline.current === null) baseline.current = snapshot;
  const formDirty = snapshot !== baseline.current;

  // Balance snapshots (the actual balance on a date; transactions after the
  // latest one are added to it).
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [newSnap, setNewSnap] = useState({ as_of: todayStr(), balance: '' });
  const [allSnapsOpen, setAllSnapsOpen] = useState(false);
  // Parse the typed balance tolerantly (strip $, commas, spaces) so e.g. "1,200.50"
  // is accepted rather than read as NaN and graying out the button.
  const snapBalance = Number(String(newSnap.balance).replace(/[,$\s]/g, ''));
  const snapValid = newSnap.balance.trim() !== '' && !Number.isNaN(snapBalance);
  // A valid balance typed into the add-snapshot row is itself an unsaved change, so
  // it should enable Save (and Save flushes it) — not just the dedicated button.
  const pendingSnap = !!account && snapValid;
  const dirty = formDirty || pendingSnap;

  // Contextual labels: the screen stays standardized across account types, but a
  // few labels/helpers adapt to liability status. Centralize them here so future
  // account-type-specific tweaks have one place to live.
  const balanceLabel = f.is_liability ? 'Balance owed' : 'Balance';
  const headerSummary = [f.name || account?.name, f.institution || account?.institution, accountTypeLabel(f.type)].filter(Boolean).join(' · ');
  // "Open" is enabled only for a well-formed http(s) URL so we never try to open junk.
  const loginUrlValid = isHttpUrl(f.login_url);

  const loadSnaps = () => { if (account) api.get<Snapshot[]>(`/accounts/${account.id}/balances`).then(setSnaps).catch(() => {}); };
  useEffect(loadSnaps, [account]);
  const sortedSnaps = useMemo(() => [...snaps].sort((a, b) => (a.as_of < b.as_of ? 1 : -1)), [snaps]);
  const addSnap = async () => {
    if (!account || !snapValid) return;
    try {
      await api.post(`/accounts/${account.id}/balances`, { balance: snapBalance, as_of: newSnap.as_of || todayStr() });
      setNewSnap({ as_of: todayStr(), balance: '' });
      loadSnaps(); onChanged();
    } catch (e: any) { setErr(e.message); }
  };
  const delSnap = async (id: number) => {
    if (!account) return;
    try { await api.del(`/accounts/${account.id}/balances/${id}`); loadSnaps(); onChanged(); } catch (e: any) { setErr(e.message); }
  };

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    const body = {
      name: f.name, type: f.type, institution: f.institution || null, is_liability: f.is_liability,
      account_number: f.account_number || null, username: f.username || null,
      interest_rate: num(f.interest_rate), credit_limit: num(f.credit_limit), due_day: num(f.due_day),
      opened_date: f.opened_date || null, beneficiaries: f.beneficiaries || null, notes: f.notes || null,
      login_url: f.login_url.trim() || null,
    };
    try {
      if (account) await api.put(`/accounts/${account.id}`, body);
      else await api.post('/accounts', body);
      // Flush a balance typed into the add-snapshot row but not yet added.
      if (pendingSnap && account) {
        await api.post(`/accounts/${account.id}/balances`, { balance: snapBalance, as_of: newSnap.as_of || todayStr() });
      }
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  const remove = async () => {
    if (!account || !confirm(`Delete account "${account.name}"? Its balance history is removed and its transactions are kept but unlinked.`)) return;
    try { await api.del(`/accounts/${account.id}`); onDeleted(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <Modal
      title={account ? 'Edit Account' : 'Add Account'}
      subtitle={account ? headerSummary : (f.name ? headerSummary : 'New account')}
      onClose={onClose}
      wide
    >
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <FormSection title="Account summary" description="What this account is and how it affects your net worth.">
        <div className="grid grid-2">
          <Field label="Account Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Everyday Checking" /></Field>
          <Field label="Institution"><input value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} placeholder="e.g. Chase" /></Field>
        </div>
        <div className="grid grid-2">
          <Field label="Account Type">
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, is_liability: account ? f.is_liability : LIABILITY_ACCOUNT_TYPES.includes(e.target.value) })}>
              {ACCOUNT_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          <div style={{ marginBottom: 12 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-soft)', marginBottom: 4, fontWeight: 500 }}>Account treatment</span>
            <label className={`check-card${f.is_liability ? ' on' : ''}`}>
              <input type="checkbox" checked={f.is_liability} onChange={(e) => setF({ ...f, is_liability: e.target.checked })} />
              <span className="check-body">
                <span className="check-title">This is a liability account</span>
                <span className="check-help">Balances for this account subtract from net worth.</span>
              </span>
            </label>
          </div>
        </div>
      </FormSection>

      <FormSection title="Account details">
        <div className="grid grid-2">
          <Field label="Account Number / Last 4"><input value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} placeholder="Last 4 recommended" /></Field>
          <Field label="Account Opened (at the Bank)"><input type="date" value={f.opened_date} onChange={(e) => setF({ ...f, opened_date: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Anything worth remembering about this account" /></Field>
      </FormSection>

      <FormSection title="Online access">
        <div className="grid grid-2-wide">
          <Field label="Login URL">
            <div className="row url-row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="url" value={f.login_url} onChange={(e) => setF({ ...f, login_url: e.target.value })} placeholder="https://bank.example.com/login" style={{ flex: 1 }} />
              <button type="button" className="ghost" disabled={!loginUrlValid} title={loginUrlValid ? 'Open in a new tab' : 'Enter a valid http(s) URL'}
                onClick={() => window.open(f.login_url.trim(), '_blank', 'noopener,noreferrer')}>Open ↗</button>
            </div>
          </Field>
          <Field label="Online Username"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="e.g. jdoe" /></Field>
        </div>
      </FormSection>

      <FormSection title="Rates, limits, and dates" description="Optional account terms you may want to track.">
        <div className="grid grid-3">
          <Field label="Interest Rate / APR (%)"><input className="num-input" inputMode="decimal" value={f.interest_rate} onChange={(e) => setF({ ...f, interest_rate: e.target.value })} placeholder="e.g. 4.25" /></Field>
          <Field label="Limit / Credit Limit"><AmountInput value={f.credit_limit} onChange={(v) => setF({ ...f, credit_limit: v })} placeholder="e.g. 10000.00" /></Field>
          <Field label="Due Day"><input className="num-input" inputMode="numeric" value={f.due_day} onChange={(e) => setF({ ...f, due_day: e.target.value })} placeholder="Day of month, 1–31" /></Field>
        </div>
      </FormSection>

      <FormSection
        title="Balance snapshots"
        description={
          <>
            Snapshots anchor the account balance as of a specific date. Transactions after the snapshot date are applied from that point forward.
            {f.is_liability && <><br />Because this is a liability account, enter the amount owed as a positive number.</>}
          </>
        }
      >
        {account ? (
          <>
            <div className="snap-add">
              <Field label="As of"><input type="date" value={newSnap.as_of} onChange={(e) => setNewSnap({ ...newSnap, as_of: e.target.value })} /></Field>
              <Field label={balanceLabel}><AmountInput value={newSnap.balance} placeholder="e.g. 9665.00" style={{ textAlign: 'right' }} onChange={(v) => setNewSnap({ ...newSnap, balance: v })} /></Field>
              <button disabled={!snapValid} onClick={addSnap}>Add Snapshot</button>
            </div>
            {f.is_liability && snapValid && snapBalance < 0 && (
              <div className="debit" style={{ fontSize: 12, marginTop: 8 }}>
                Heads up: this is a liability, so a negative balance counts as money you're owed. Enter the amount owed as a positive number.
              </div>
            )}
            {snaps.length > 0 && (
              <div className="card" style={{ padding: 0, marginTop: 12 }}>
                <table className="ledger">
                  <thead><tr><th>As of</th><th className="r">{balanceLabel}</th><th></th></tr></thead>
                  <tbody>
                    {sortedSnaps.slice(0, SNAP_PREVIEW).map((s, i) => (
                      <tr key={s.id}>
                        <td className="num">{shortDate(s.as_of)}{i === 0 && <span className="tag anchor" style={{ marginLeft: 8 }} title={ANCHOR_TIP}>Anchor</span>}</td>
                        <td className="r money num">{money(s.balance)}</td>
                        <td className="r"><button className="ghost" style={{ padding: '2px 8px' }} title="Delete snapshot" onClick={() => delSnap(s.id)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {snaps.length > SNAP_PREVIEW && (
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--hairline)' }}>
                    <span className="muted" style={{ fontSize: 12 }}>Showing latest {SNAP_PREVIEW} of {snaps.length}</span>
                    <button className="ghost" style={{ padding: '2px 10px' }} onClick={() => setAllSnapsOpen(true)}>View all</button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>Add the account first, then reopen it to record a balance snapshot.</div>
        )}
      </FormSection>

      <FormSection title="Additional details" subtle>
        <Field label="Beneficiaries"><input value={f.beneficiaries} onChange={(e) => setF({ ...f, beneficiaries: e.target.value })} placeholder="e.g. Jane Doe (50%), …" /></Field>
      </FormSection>

      <EditorFooter onClose={onClose} onSave={save} onDelete={account ? remove : undefined}
        saveLabel={account ? 'Save Changes' : 'Add Account'} disabled={!dirty}
        closeLabel="Cancel"
        statusHint={account && dirty ? <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span> : undefined} />

      {allSnapsOpen && account && (
        <Modal title={`Balance snapshots · ${account.name}`} onClose={() => setAllSnapsOpen(false)}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{snaps.length} snapshot{snaps.length === 1 ? '' : 's'}, newest first. The latest is the anchor for the computed balance.</div>
          <div className="card" style={{ padding: 0, maxHeight: '60vh', overflowY: 'auto' }}>
            <table className="ledger">
              <thead><tr><th>As of</th><th className="r">{balanceLabel}</th><th></th></tr></thead>
              <tbody>
                {sortedSnaps.map((s, i) => (
                  <tr key={s.id}>
                    <td className="num">{shortDate(s.as_of)}{i === 0 && <span className="tag anchor" style={{ marginLeft: 8 }} title={ANCHOR_TIP}>Anchor</span>}</td>
                    <td className="r money num">{money(s.balance)}</td>
                    <td className="r"><button className="ghost" style={{ padding: '2px 8px' }} title="Delete snapshot" onClick={() => delSnap(s.id)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
