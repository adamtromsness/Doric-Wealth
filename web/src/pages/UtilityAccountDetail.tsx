import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, money, shortDate, todayStr, isOpenableUrl, formatPhone } from '../api';
import { cap, BackLink, Field, EditorSection, chartTooltip, Loading } from '../components/ui';
import { ColumnBar } from '../components/ColumnBar';
import { EntityDocuments } from '../components/EntityDocuments';
import {
  InvoiceEditor, UnpaidInvoiceTable, PaidInvoiceTable,
  avgBilledPerAccount, estimatedMonthly, cycleMonths, ordinal, invoiceHasAccount, amountOwed,
  type UtilAccount, type Invoice, type Property, type BankAccount,
} from './Utilities';
import { TYPES, UNIT_HINT, BILLING_CYCLES, normalizeUrl, accountSeries, billStats, PAYMENT_PLANS, paymentPlanLabel, isDisabledUtil, isPayableFrom } from './utilities/invoiceHelpers';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodLabel = (d: string) => { const [y, m] = d.split('-'); return `${MONTHS[Number(m) - 1] ?? m} ${y.slice(2)}`; };

type Tab = 'overview' | 'invoices' | 'documents' | 'details';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'documents', label: 'Documents' },
  { key: 'details', label: 'Details' },
];

// Document categories for a utility account (statements, agreements, letters, …).
const UTILITY_DOC_TYPES: [string, string][] = [
  ['statement', 'Statement'],
  ['agreement', 'Agreement'],
  ['notice', 'Notice / Letter'],
  ['rate_plan', 'Rate Plan'],
  ['correspondence', 'Correspondence'],
  ['other', 'Other'],
];

const PAID_PAGE = 25;

function FactList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="detail-list">
      {items.map((f, i) => (<div key={i} className="detail-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>))}
    </dl>
  );
}

// A card's main heading + its content (matches the vehicle/property Details layout).
function Section({ title, children, headStyle }: { title: string; children: ReactNode; headStyle?: CSSProperties }) {
  return (<><div className="label" style={headStyle}>{title}</div>{children}</>);
}

export default function UtilityAccountDetail() {
  const { accountId } = useParams();
  const isNew = accountId === 'new';
  const id = Number(accountId);
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<UtilAccount[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [addInvoice, setAddInvoice] = useState(false);
  const [editInvoice, setEditInvoice] = useState<Invoice | null>(null);
  const [paidPage, setPaidPage] = useState(0);
  const [canceling, setCanceling] = useState(false);
  const [cancelDate, setCancelDate] = useState('');
  const [err, setErr] = useState('');

  const account = accounts.find((a) => a.id === id) ?? null;

  const loadAccounts = () => api.get<UtilAccount[]>('/utilities/accounts')
    .then((all) => { setAccounts(all); if (!all.some((a) => a.id === id)) setErr('Utility account not found.'); })
    .catch((e) => setErr(e.message));
  // Scope to this account so we get its COMPLETE invoice history (the book-wide list is
  // capped) — the billing stats below are derived from the full set.
  const loadInvoices = () => api.get<Invoice[]>(`/utilities/invoices?account_id=${id}`).then(setInvoices).catch(() => {});

  useEffect(() => {
    api.get<Property[]>('/properties').then(setProperties).catch(() => {});
    api.get<BankAccount[]>('/accounts').then(setBankAccounts).catch(() => {});
    if (isNew) return; // "new" mode renders an empty Add form; nothing to load
    if (!Number.isFinite(id)) { setErr('Invalid utility account.'); return; }
    loadAccounts(); loadInvoices();
  }, [id]);

  // Invoices touching this account, split into unpaid (due soonest first) and
  // paid (most recently paid first) — mirroring the list page.
  const acctInvoices = useMemo(() => invoices.filter((i) => invoiceHasAccount(i, id)), [invoices, id]);
  const unpaid = useMemo(() =>
    acctInvoices.filter((i) => !i.paid).sort((a, b) => (a.due_date || '9999-99-99').localeCompare(b.due_date || '9999-99-99') || b.id - a.id),
    [acctInvoices]);
  const paid = useMemo(() =>
    acctInvoices.filter((i) => i.paid).sort((a, b) => (b.paid_date || '').localeCompare(a.paid_date || '') || b.id - a.id),
    [acctInvoices]);
  const monthly = useMemo(() => (account ? estimatedMonthly(account, avgBilledPerAccount(acctInvoices)) : 0), [account, acctInvoices]);
  // Per-period billed amount & usage for this account, oldest → newest (drives the
  // cost/usage trend charts and the billing statistics).
  const series = useMemo(() => accountSeries(invoices, id), [invoices, id]);
  const stats = useMemo(() => billStats(series), [series]);

  const paidPageCount = Math.max(1, Math.ceil(paid.length / PAID_PAGE));
  const paidSafePage = Math.min(paidPage, paidPageCount - 1);
  const paidStart = paidSafePage * PAID_PAGE;
  const pagePaid = paid.slice(paidStart, paidStart + PAID_PAGE);

  // "Add utility account" — render the inline form on the page (no popup). Placed
  // after all hooks so the hook order stays stable across the /new → /:id navigation.
  if (isNew) {
    return (
      <>
        <BackLink to="/utilities" label="Back to Utilities" />
        <div className="page-head" style={{ marginTop: 10 }}>
          <div>
            <h1 className="title">Add Utility Account</h1>
            <p className="subtitle">Track a recurring property bill — electricity, gas, water, internet — and log its invoices over time.</p>
          </div>
        </div>
        <UtilAccountInfoForm account={null} isNew properties={properties} bankAccounts={bankAccounts} onSaved={(na) => na && navigate(`/utilities/${na.id}`)} />
      </>
    );
  }

  if (err && !account) {
    return (<><BackLink to="/utilities" label="Back to Utilities" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>);
  }
  if (!account) return <Loading />;

  const a = account;
  const subtitle = [cap(a.utility_type), cap(a.billing_cycle), a.property_name].filter(Boolean).join(' · ');
  const owedNow = unpaid.reduce((s, i) => s + amountOwed(i), 0);
  const unit = a.usage_unit || UNIT_HINT[a.utility_type] || 'units';
  const hasUsage = series.some((p) => p.usage != null && p.usage > 0);
  const lastDelta = stats.last != null && stats.prev != null && stats.prev > 0 ? ((stats.last - stats.prev) / stats.prev) * 100 : null;
  const deltaNode = lastDelta == null ? null : (
    <span className={lastDelta > 0 ? 'debit' : 'credit'} style={{ fontSize: 12, marginLeft: 6 }}>{lastDelta > 0 ? '▲' : '▼'} {Math.abs(lastDelta).toFixed(0)}%</span>
  );

  // Billing statistics (from logged invoices), shown on the Overview.
  const billingFacts: { label: string; value: ReactNode }[] = [];
  if (stats.count) {
    billingFacts.push({ label: 'Average Bill', value: money(stats.average) });
    billingFacts.push({ label: 'Last Bill', value: <>{money(stats.last!)}{deltaNode}</> });
    billingFacts.push({ label: 'Highest / Lowest', value: `${money(stats.highest!)} / ${money(stats.lowest!)}` });
    billingFacts.push({ label: 'This Year', value: money(stats.ytd) });
    billingFacts.push({ label: 'Last 12 Months', value: money(stats.trailing12) });
    if (stats.costPerUnit != null) billingFacts.push({ label: `Cost / ${unit}`, value: money(stats.costPerUnit) });
    if (stats.avgUsage != null) billingFacts.push({ label: 'Avg Usage / Bill', value: `${Math.round(stats.avgUsage).toLocaleString()} ${unit}` });
  }
  billingFacts.push({ label: 'Estimated / Month', value: monthly > 0 ? money(monthly) : '—' });
  billingFacts.push({ label: 'Estimated / Year', value: monthly > 0 ? money(monthly * cycleMonths('yearly')) : '—' });

  // Account metadata facts.
  const accountFacts: { label: string; value: ReactNode }[] = [
    { label: 'Billing Cycle', value: cap(a.billing_cycle) },
  ];
  if (a.due_day != null) accountFacts.push({ label: 'Due Day', value: ordinal(a.due_day) });
  if (a.property_name) accountFacts.push({ label: 'Property', value: a.property_name });
  if (a.account_holder) accountFacts.push({ label: 'Account Holder', value: a.account_holder });
  if (a.account_number) accountFacts.push({ label: 'Account Number', value: a.account_number });
  if (a.meter_number) accountFacts.push({ label: 'Meter / Service #', value: a.meter_number });
  if (a.rate_plan) accountFacts.push({ label: 'Rate Plan', value: a.rate_plan });
  accountFacts.push({
    label: 'Autopay',
    value: a.is_autopay
      ? `On${a.autopay_day ? ` · the ${ordinal(a.autopay_day)}` : ''}${a.payment_account_name ? ` · from ${a.payment_account_name}` : ''}`
      : 'Off',
  });
  accountFacts.push({ label: 'Payment Plan', value: paymentPlanLabel(a.payment_plan) });
  if (normalizeUrl(a.provider_url)) accountFacts.push({ label: 'Website', value: <a href={normalizeUrl(a.provider_url)!} target="_blank" rel="noreferrer">Visit ↗</a> });
  if (a.provider_phone) accountFacts.push({ label: 'Provider Phone', value: <a href={`tel:${a.provider_phone.replace(/[^\d+]/g, '')}`}>{formatPhone(a.provider_phone)}</a> });
  if (a.login_id) accountFacts.push({ label: 'Login ID', value: a.login_id });
  if (normalizeUrl(a.login_url)) accountFacts.push({ label: 'Portal', value: <a href={normalizeUrl(a.login_url)!} target="_blank" rel="noreferrer">Log In ↗</a> });

  const disabled = isDisabledUtil(a);
  const startCancel = () => { setCancelDate(a.end_date?.slice(0, 10) || todayStr()); setCanceling(true); };
  const doCancel = async () => {
    setErr('');
    try { await api.post(`/utilities/accounts/${id}/cancel`, { date: cancelDate || todayStr() }); setCanceling(false); loadAccounts(); } catch (e: any) { setErr(e.message); }
  };
  const doReactivate = async () => {
    setErr('');
    try { await api.post(`/utilities/accounts/${id}/reactivate`); loadAccounts(); } catch (e: any) { setErr(e.message); }
  };

  const reloadAll = () => { loadAccounts(); loadInvoices(); };
  const onInvoiceSaved = () => { setAddInvoice(false); setEditInvoice(null); reloadAll(); };

  return (
    <>
      <BackLink to="/utilities" label="Back to Utilities" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {a.name}
            <span className="tag">{cap(a.utility_type)}</span>
            {Number(a.unpaid_amount) > 0 && <span className="tag" style={{ color: 'var(--debit)', borderColor: 'var(--debit)' }}>{a.unpaid_count} unpaid</span>}
            {disabled && <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}>Canceled</span>}
          </h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
          <div style={{ marginTop: 10 }}>
            <span className="num debit" style={{ fontSize: 26, fontWeight: 600 }}>{monthly > 0 ? money(monthly) : '—'}</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>est. / month</span>
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {disabled && (
        <div className="banner" style={{ marginBottom: 12 }}>
          Service canceled{a.end_date ? ` as of ${shortDate(a.end_date)}` : ''} — kept for history. Use “Reactivate Service” on the Details tab to turn it back on.
        </div>
      )}
      {!disabled && a.end_date && (
        <div className="banner" style={{ marginBottom: 12 }}>
          Scheduled to cancel on {shortDate(a.end_date)}.
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Est. Cost / Month</div><div className="value debit">{monthly > 0 ? money(monthly) : '—'}</div><div className="muted" style={{ fontSize: 11 }}>from billed history</div></div>
            <div className="card stat">
              <div className="label">Last Bill</div>
              <div className="value">{stats.last != null ? money(stats.last) : '—'}{deltaNode}</div>
              <div className="muted" style={{ fontSize: 11 }}>{stats.count ? `${stats.count} bill${stats.count === 1 ? '' : 's'} logged` : 'no invoices yet'}</div>
            </div>
            <div className="card stat"><div className="label">Outstanding</div><div className={`value ${Number(a.unpaid_amount) > 0 ? 'debit' : ''}`}>{money(a.unpaid_amount)}</div><div className="muted" style={{ fontSize: 11 }}>{a.unpaid_count} unpaid</div></div>
            <div className="card stat"><div className="label">Total Billed</div><div className="value">{money(a.total_billed)}</div><div className="muted" style={{ fontSize: 11 }}>{stats.trailing12 > 0 ? `${money(stats.trailing12)} last 12mo` : `${a.invoice_count} invoice${a.invoice_count === 1 ? '' : 's'}`}</div></div>
          </div>

          {series.length >= 2 && (
            <div className={hasUsage ? 'grid grid-2' : ''} style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="label" style={{ marginBottom: 8 }}>Cost Over Time</div>
                <div style={{ height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                      <XAxis dataKey="date" tickFormatter={periodLabel} tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} minTickGap={16} />
                      <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => '$' + (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                      <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [money(Number(v)), 'Bill']} labelFormatter={(d) => shortDate(String(d))} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                      <Bar dataKey="amount" fill="#5A6F87" shape={<ColumnBar />} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {hasUsage && (
                <div className="card">
                  <div className="label" style={{ marginBottom: 8 }}>Usage Over Time <span className="muted" style={{ fontWeight: 400 }}>({unit})</span></div>
                  <div style={{ height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                        <XAxis dataKey="date" tickFormatter={periodLabel} tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} minTickGap={16} />
                        <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                        <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [`${Number(v).toLocaleString()} ${unit}`, 'Usage']} labelFormatter={(d) => shortDate(String(d))} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                        <Bar dataKey="usage" fill="#6B7F6E" shape={<ColumnBar />} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="label" style={{ marginBottom: 10 }}>Billing</div>
            <FactList items={billingFacts} />
          </div>

          <div className="card">
            <div className="label" style={{ marginBottom: 10 }}>Account</div>
            <FactList items={accountFacts} />
          </div>
        </>
      )}

      {tab === 'invoices' && (
        <>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 14 }}>
            <div className="card stat" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
              <div className="label">Outstanding</div>
              <div className={`value ${owedNow > 0 ? 'debit' : ''}`}>{money(owedNow)}</div>
              <div className="muted" style={{ fontSize: 11 }}>{unpaid.length} unpaid</div>
            </div>
            <div className="card stat" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
              <div className="label">Est. / Month</div>
              <div className="value">{monthly > 0 ? money(monthly) : '—'}</div>
              <div className="muted" style={{ fontSize: 11 }}>{cap(a.billing_cycle)}{a.due_day != null ? ` · due ${ordinal(a.due_day)}` : ''}</div>
            </div>
            <div className="card stat" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
              <div className="label">Total Billed</div>
              <div className="value">{money(a.total_billed)}</div>
              <div className="muted" style={{ fontSize: 11 }}>{a.invoice_count} invoice{a.invoice_count === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div className="label" style={{ margin: 0 }}>Unpaid Invoices</div>
            <button onClick={() => setAddInvoice(true)}>Add Invoice</button>
          </div>
          <div style={{ marginBottom: 20 }}>
            <UnpaidInvoiceTable items={unpaid} onEdit={setEditInvoice}
              emptyText={acctInvoices.length === 0 ? 'No invoices yet. Add one to start.' : 'No unpaid invoices. 🎉'} />
          </div>

          <div className="label" style={{ margin: '4px 0 6px' }}>Paid Invoices</div>
          <PaidInvoiceTable items={pagePaid} onEdit={setEditInvoice} />
          {paidPageCount > 1 && (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
              <span className="muted num" style={{ fontSize: 13 }}>Showing {paidStart + 1}–{paidStart + pagePaid.length} of {paid.length}</span>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <button className="ghost" disabled={paidSafePage === 0} onClick={() => setPaidPage(Math.max(0, paidSafePage - 1))}>Previous</button>
                <span className="muted num" style={{ fontSize: 13 }}>Page {paidSafePage + 1} of {paidPageCount}</span>
                <button className="ghost" disabled={paidSafePage >= paidPageCount - 1} onClick={() => setPaidPage(Math.min(paidPageCount - 1, paidSafePage + 1))}>Next</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'documents' && <EntityDocuments basePath={`/utilities/accounts/${id}`} docTypes={UTILITY_DOC_TYPES} />}

      {tab === 'details' && (
        <>
          <UtilAccountInfoForm
            account={a}
            properties={properties}
            bankAccounts={bankAccounts}
            onSaved={reloadAll}
            onDeleted={() => navigate('/utilities')}
          />

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="section" style={{ margin: 0 }}>Cancel Service</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {disabled
                    ? `Canceled${a.end_date ? ` as of ${shortDate(a.end_date)}` : ''} — kept for history.`
                    : a.end_date
                      ? `Scheduled to cancel on ${shortDate(a.end_date)}. Reactivate to clear it.`
                      : 'Moved out or switched providers? Disable this account to stop tracking it — its invoice history is kept.'}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {disabled || a.end_date
                  ? <button className="ghost" onClick={doReactivate}>Reactivate Service</button>
                  : !canceling && <button className="ghost" onClick={startCancel}>Cancel Service</button>}
              </div>
            </div>
            {!disabled && !a.end_date && canceling && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
                <div className="grid grid-2">
                  <Field label="Cancellation Date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} /></Field>
                </div>
                <div className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
                  {cancelDate && cancelDate > todayStr()
                    ? `Stays active until ${shortDate(cancelDate)}, then cancels.`
                    : 'Cancels immediately — its history is kept.'}
                </div>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <button className="ghost" onClick={() => setCanceling(false)}>Cancel</button>
                  <button onClick={doCancel}>Disable Service</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {(addInvoice || editInvoice) && (
        <InvoiceEditor
          invoice={editInvoice}
          accounts={accounts}
          bankAccounts={bankAccounts}
          onClose={() => { setAddInvoice(false); setEditInvoice(null); }}
          onSaved={onInvoiceSaved}
        />
      )}
    </>
  );
}

// Editable account info, rendered inline on the Details tab (no popup). A Save button
// enables once something changes. Mirrors the vehicle/property Details forms.
function UtilAccountInfoForm({ account, isNew = false, properties, bankAccounts, onSaved, onDeleted }: {
  account: UtilAccount | null; isNew?: boolean; properties: Property[]; bankAccounts: BankAccount[]; onSaved: (a?: UtilAccount) => void; onDeleted?: () => void;
}) {
  const seedOf = (a: UtilAccount | null) => ({
    name: a?.name ?? '',
    provider: a?.provider ?? '',
    utility_type: a?.utility_type ?? 'electricity',
    billing_cycle: a?.billing_cycle ?? 'monthly',
    account_number: a?.account_number ?? '',
    property_id: a?.property_id?.toString() ?? '',
    due_day: a?.due_day?.toString() ?? '',
    usage_unit: a?.usage_unit ?? '',
    account_holder: a?.account_holder ?? '',
    meter_number: a?.meter_number ?? '',
    rate_plan: a?.rate_plan ?? '',
    is_autopay: a?.is_autopay ?? false,
    autopay_day: a?.autopay_day?.toString() ?? '',
    payment_account_id: a?.payment_account_id?.toString() ?? '',
    payment_plan: a?.payment_plan ?? 'actual',
    payment_method: a?.payment_method ?? '',
    provider_url: a?.provider_url ?? '',
    login_url: a?.login_url ?? '',
    login_id: a?.login_id ?? '',
    provider_phone: a?.provider_phone ?? '',
    notes: a?.notes ?? '',
  });

  const [f, setF] = useState(() => seedOf(account));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seedOf(account)));
  useEffect(() => { const s = seedOf(account); setF(s); setSavedJson(JSON.stringify(s)); }, [account?.id]);
  const dirty = JSON.stringify(f) !== savedJson;

  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const num = (s: string) => (s === '' ? null : Number(s));
  // Accounts a bill can be paid from (keep the current selection visible even if it
  // would otherwise be filtered out).
  const payableAccounts = bankAccounts.filter((acc) => isPayableFrom(acc) || String(acc.id) === f.payment_account_id);
  // An "Open" button next to a URL field — disabled until a real http(s) URL is entered.
  const OpenBtn = ({ value }: { value: string }) => (
    <button type="button" className="ghost" disabled={!isOpenableUrl(value)}
      onClick={() => { const u = normalizeUrl(value); if (u) window.open(u, '_blank', 'noopener'); }}
      style={{ whiteSpace: 'nowrap' }}>Open</button>
  );

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name, provider: f.provider || null, utility_type: f.utility_type, billing_cycle: f.billing_cycle,
      account_number: f.account_number || null, property_id: f.property_id ? Number(f.property_id) : null,
      due_day: num(f.due_day), usage_unit: f.usage_unit || null,
      account_holder: f.account_holder.trim() || null, meter_number: f.meter_number.trim() || null, rate_plan: f.rate_plan.trim() || null,
      is_autopay: f.is_autopay, autopay_day: f.is_autopay ? num(f.autopay_day) : null,
      payment_account_id: f.is_autopay && f.payment_account_id ? Number(f.payment_account_id) : null,
      payment_plan: f.payment_plan, payment_method: f.payment_method.trim() || null,
      provider_url: f.provider_url.trim() || null,
      login_url: f.login_url.trim() || null, login_id: f.login_id.trim() || null, provider_phone: f.provider_phone.trim() || null,
      notes: f.notes || null,
    };
    try {
      const saved = isNew
        ? await api.post<UtilAccount>('/utilities/accounts', body)
        : await api.put<UtilAccount>(`/utilities/accounts/${account!.id}`, body);
      setSavedJson(JSON.stringify(f));
      onSaved(saved);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!account || !confirm(`Delete account "${account.name}"? Its invoice lines will be unlinked.`)) return;
    try { await api.del(`/utilities/accounts/${account.id}`); onDeleted?.(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>{isNew ? 'New Utility Account' : 'Account Details'}</div>
        <div className="btn-row">
          {!isNew && onDeleted && <button className="danger" onClick={remove}>Delete</button>}
          <button onClick={save} disabled={(!dirty && !isNew) || saving}>{saving ? 'Saving…' : isNew ? 'Add Account' : 'Save Changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <Section title="Account" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-4">
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. City of Austin – Water" /></Field>
            <Field label="Provider / Biller"><input value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} /></Field>
            <Field label="Type">
              <select value={f.utility_type} onChange={(e) => setF({ ...f, utility_type: e.target.value, usage_unit: f.usage_unit || UNIT_HINT[e.target.value] || '' })}>
                {TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
              </select>
            </Field>
            <Field label="Property">
              <select value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}>
                <option value="">— Not assigned —</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-4">
            <Field label="Billing Cycle">
              <select value={f.billing_cycle} onChange={(e) => setF({ ...f, billing_cycle: e.target.value })}>
                {BILLING_CYCLES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
              </select>
            </Field>
            <Field label="Due Day (1–31)"><input className="num-input" inputMode="numeric" value={f.due_day} onChange={(e) => setF({ ...f, due_day: e.target.value })} placeholder="e.g. 15" /></Field>
            <Field label="Account Number"><input value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></Field>
            <Field label="Account Holder"><input value={f.account_holder} onChange={(e) => setF({ ...f, account_holder: e.target.value })} placeholder="whose name it's under" /></Field>
          </div>
          <div className="grid grid-3">
            <Field label="Meter / Service #"><input value={f.meter_number} onChange={(e) => setF({ ...f, meter_number: e.target.value })} /></Field>
            <Field label="Rate Plan"><input value={f.rate_plan} onChange={(e) => setF({ ...f, rate_plan: e.target.value })} placeholder="e.g. Time-of-Use" /></Field>
            <Field label="Usage Unit"><input value={f.usage_unit} onChange={(e) => setF({ ...f, usage_unit: e.target.value })} placeholder={UNIT_HINT[f.utility_type] ?? 'unit'} /></Field>
          </div>

          <EditorSection title="Notes" />
          <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="Payment" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <label className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.is_autopay} onChange={(e) => setF({ ...f, is_autopay: e.target.checked })} />
            <span>Pays automatically (autopay)</span>
          </label>
          {f.is_autopay && (
            <div className="grid grid-2">
              <Field label="Autopay Day (1–31)"><input className="num-input" inputMode="numeric" value={f.autopay_day} onChange={(e) => setF({ ...f, autopay_day: e.target.value })} placeholder="e.g. 5" /></Field>
              <Field label="Paid From">
                <select value={f.payment_account_id} onChange={(e) => setF({ ...f, payment_account_id: e.target.value })}>
                  <option value="">— Select an account —</option>
                  {payableAccounts.map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                </select>
              </Field>
            </div>
          )}
          <Field label="Payment Plan">
            <select value={f.payment_plan} onChange={(e) => setF({ ...f, payment_plan: e.target.value as 'actual' | 'average' })}>
              {PAYMENT_PLANS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          <div className="muted" style={{ fontSize: 12 }}>Budget billing (average) charges a leveled amount each period; actual usage charges what you used.</div>
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="Provider & Access" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-2">
            <Field label="Provider Web Address">
              <div className="row" style={{ gap: 8 }}>
                <input value={f.provider_url} onChange={(e) => setF({ ...f, provider_url: e.target.value })} placeholder="e.g. coautilities.com" style={{ flex: 1 }} />
                <OpenBtn value={f.provider_url} />
              </div>
            </Field>
            <Field label="Provider Phone"><input value={f.provider_phone} onChange={(e) => setF({ ...f, provider_phone: e.target.value })} onBlur={(e) => setF({ ...f, provider_phone: formatPhone(e.target.value) })} placeholder="e.g. (512) 555-0100" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Login URL">
              <div className="row" style={{ gap: 8 }}>
                <input value={f.login_url} onChange={(e) => setF({ ...f, login_url: e.target.value })} placeholder="e.g. coautilities.com/login" style={{ flex: 1 }} />
                <OpenBtn value={f.login_url} />
              </div>
            </Field>
            <Field label="Login ID"><input value={f.login_id} onChange={(e) => setF({ ...f, login_id: e.target.value })} placeholder="username or email" /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>The provider's site and the portal where you sign in to view or pay bills. Stored for quick access — don't keep your password here.</div>
        </Section>
      </div>
    </>
  );
}
