import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate } from '../api';
import { type RangeKey, RANGES, rangeDates } from '../dateRange';
import { Field, DragHandle, arrayMove, slotReorder, CHART_COLORS, chartTooltip, CHIP, cap, AMOUNT_OPS, AmountInput } from '../components/ui';
import {
  type UtilAccount, type Invoice, type Property, type BankAccount,
  INVOICE_PAGE, avgBilledPerAccount, estimatedMonthly, amountOwed, ordinal, isDisabledUtil,
} from './utilities/invoiceHelpers';
import { UnpaidInvoiceTable, PaidInvoiceTable } from './utilities/InvoiceTables';
import { InvoiceEditor } from './utilities/InvoiceEditor';

// Re-export barrel — preserve the public surface for ./Utilities consumers.
export {
  cycleMonths, invoiceBase, amountOwed, isPartial, lineLabel, ordinal, isOverdue, dueLabel,
  avgBilledPerAccount, estimatedMonthly, invoiceHasAccount,
} from './utilities/invoiceHelpers';
export type { Property, BankAccount, UtilAccount, InvoiceLine, Invoice } from './utilities/invoiceHelpers';
export { UnpaidInvoiceTable, PaidInvoiceTable } from './utilities/InvoiceTables';
export { InvoiceEditor } from './utilities/InvoiceEditor';

export default function Utilities() {
  const [accounts, setAccounts] = useState<UtilAccount[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [propFilter, setPropFilter] = useState<number | 'all'>('all');
  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('utilities.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('utilities.hideCharts', v ? '1' : '0'); return !v; });
  const [showAccounts, setShowAccounts] = useState(() => localStorage.getItem('utilities.hideAccounts') !== '1');
  const toggleAccounts = () => setShowAccounts((v) => { localStorage.setItem('utilities.hideAccounts', v ? '1' : '0'); return !v; });
  const [showDisabled, setShowDisabled] = useState(() => localStorage.getItem('utilities.showDisabled') === '1');
  const toggleDisabled = () => setShowDisabled((v) => { localStorage.setItem('utilities.showDisabled', v ? '0' : '1'); return !v; });
  const [chartView, setChartView] = useState<'monthly' | 'yearly'>('monthly');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [acctFilter, setAcctFilter] = useState('');
  const [acctDragIdx, setAcctDragIdx] = useState<number | null>(null);
  const [range, setRange] = useState<RangeKey>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [amountOp, setAmountOp] = useState('');
  const [amount, setAmount] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [invPage, setInvPage] = useState(0);
  const [editInvoice, setEditInvoice] = useState<Invoice | null>(null);
  const [addInvoice, setAddInvoice] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const load = () => {
    api.get<UtilAccount[]>('/utilities/accounts').then(setAccounts).catch((e) => setErr(e.message));
    api.get<Invoice[]>('/utilities/invoices').then(setInvoices).catch((e) => setErr(e.message));
  };
  useEffect(() => {
    load();
    api.get<Property[]>('/properties').then(setProperties).catch(() => {});
    api.get<BankAccount[]>('/accounts').then(setBankAccounts).catch(() => {});
  }, []);

  // Accounts in the selected property (drives the summary, charts, and lists).
  const viewAccounts = useMemo(
    () => (propFilter === 'all' ? accounts : accounts.filter((a) => a.property_id === propFilter)),
    [accounts, propFilter]
  );
  const viewAcctIds = useMemo(() => new Set(viewAccounts.map((a) => a.id)), [viewAccounts]);
  // Active vs. disabled (canceled) accounts — disabled are hidden in a collapsible
  // section at the bottom and excluded from the summary/charts/totals.
  const activeAccounts = useMemo(() => viewAccounts.filter((a) => !isDisabledUtil(a)), [viewAccounts]);
  const disabledAccounts = useMemo(() => viewAccounts.filter(isDisabledUtil), [viewAccounts]);

  const avgPerAccount = useMemo(() => avgBilledPerAccount(invoices), [invoices]);
  const monthlyForAccount = (a: UtilAccount) => estimatedMonthly(a, avgPerAccount);

  const monthlyTotal = activeAccounts.reduce((s, a) => s + monthlyForAccount(a), 0);
  const yearlyTotal = monthlyTotal * 12;

  const inView = (i: Invoice) => propFilter === 'all' || i.lines.some((l) => l.utility_account_id != null && viewAcctIds.has(l.utility_account_id));
  const outstanding = invoices.filter((i) => !i.paid && inView(i)).reduce((s, i) => s + amountOwed(i), 0);
  const unpaidCount = invoices.filter((i) => !i.paid && inView(i)).length;
  const nextDue = invoices.filter((i) => !i.paid && i.due_date && inView(i)).map((i) => i.due_date!).sort()[0];

  // Chart data, scaled to a monthly or yearly figure via the view toggle.
  const mult = chartView === 'yearly' ? 12 : 1;
  const viewWord = chartView === 'yearly' ? 'Yearly' : 'Monthly';
  const spendByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of activeAccounts) m.set(cap(a.utility_type), (m.get(cap(a.utility_type)) ?? 0) + monthlyForAccount(a) * mult);
    return [...m.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  }, [activeAccounts, avgPerAccount, mult]);
  const spendByAccount = useMemo(() =>
    activeAccounts.map((a) => ({ name: a.name, value: Math.round(monthlyForAccount(a) * mult * 100) / 100 }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 8),
    [activeAccounts, avgPerAccount, mult]
  );
  const typeTotal = spendByType.reduce((s, x) => s + x.value, 0);
  const hasCharts = spendByAccount.length > 0;

  const selectedAcctIds = acctFilter ? acctFilter.split(',').map(Number) : [];
  const toggleAcct = (id: number) => {
    const set = new Set(selectedAcctIds);
    set.has(id) ? set.delete(id) : set.add(id);
    setAcctFilter([...set].join(','));
  };
  // Drag-to-reorder accounts; persist the full list's new order.
  const reorderAccounts = async (from: number, to: number) => {
    if (from === to) return;
    const displayed = activeAccounts.map((a) => a.id);
    const next = arrayMove(displayed, from, to);
    try { await api.post('/utilities/accounts/reorder', { ids: slotReorder(accounts.map((a) => a.id), displayed, next) }); load(); } catch (e: any) { setErr(e.message); }
  };

  const filteredInvoices = useMemo(() => {
    const { from, to } = rangeDates(range, fromDate, toDate);
    const ids = acctFilter ? acctFilter.split(',').map(Number) : [];
    return invoices.filter((i) => {
      if (propFilter !== 'all' && !i.lines.some((l) => l.utility_account_id != null && viewAcctIds.has(l.utility_account_id))) return false;
      if (ids.length && !i.lines.some((l) => l.utility_account_id != null && ids.includes(l.utility_account_id))) return false;
      if (from || to) {
        const d = (i.invoice_date || i.due_date || '').slice(0, 10);
        if (from && d < from) return false;
        if (to && (d === '' || d > to)) return false;
      }
      if (amountOp && amount !== '') {
        const v = Number(amount), t = Number(i.total);
        if (amountOp === 'gt' && !(t > v)) return false;
        if (amountOp === 'lt' && !(t < v)) return false;
        if (amountOp === 'eq' && Math.abs(t - v) > 0.005) return false;
        if (amountOp === 'between' && (t < v || (amountMax !== '' && t > Number(amountMax)))) return false;
      }
      return true;
    });
  }, [invoices, acctFilter, propFilter, viewAcctIds, range, fromDate, toDate, amountOp, amount, amountMax]);

  // Unpaid (incl. partials) sorted by due date, soonest/most overdue on top;
  // paid sorted by most recently paid.
  const unpaidInvoices = useMemo(() =>
    filteredInvoices.filter((i) => !i.paid).sort((a, b) => (a.due_date || '9999-99-99').localeCompare(b.due_date || '9999-99-99') || b.id - a.id),
    [filteredInvoices]);
  const paidInvoices = useMemo(() =>
    filteredInvoices.filter((i) => i.paid).sort((a, b) => (b.paid_date || '').localeCompare(a.paid_date || '') || b.id - a.id),
    [filteredInvoices]);

  const advCount = amountOp && amount !== '' ? 1 : 0;
  const filtersActive = !!acctFilter || range !== 'all' || advCount > 0;
  const clearFilters = () => { setAcctFilter(''); setRange('all'); setFromDate(''); setToDate(''); setAmountOp(''); setAmount(''); setAmountMax(''); };

  // Paginate the paid (history) table, 25 per page.
  const invPageCount = Math.max(1, Math.ceil(paidInvoices.length / INVOICE_PAGE));
  const invSafePage = Math.min(invPage, invPageCount - 1);
  const invStart = invSafePage * INVOICE_PAGE;
  const pagePaid = paidInvoices.slice(invStart, invStart + INVOICE_PAGE);
  useEffect(() => { setInvPage(0); }, [acctFilter, propFilter, range, fromDate, toDate, amountOp, amount, amountMax]);


  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Track</div>
          <h1 className="title">Utilities</h1>
          <p className="subtitle">
            Track recurring charges tied to a property — electricity, gas, water, internet, trash, and the like.
            Every utility account links to a property, so set up your <Link to="/properties">properties</Link> first.
            Logging each invoice unlocks smarter tracking of charges and usage over time.
          </p>
        </div>
        <button className="head-add" onClick={() => navigate('/utilities/new')} disabled={properties.length === 0}>Add Account</button>
      </div>

      {err && <div className="error">{err}</div>}

      {properties.length === 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="muted">Utility accounts attach to a property. <Link to="/properties">Add a Property</Link> first to start tracking utilities.</div>
        </div>
      )}

      {properties.length > 0 && (
        <div className="row" style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {hasCharts && <button className="ghost" onClick={toggleCharts}>{showCharts ? 'Hide Charts' : 'Show Charts'}</button>}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>Property</span>
            <select value={String(propFilter)} onChange={(e) => { const v = e.target.value; setPropFilter(v === 'all' ? 'all' : Number(v)); setAcctFilter(''); }} style={{ width: 'auto', minWidth: 175 }}>
              <option value="all">All Properties</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      )}

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="card stat"><div className="label">Cost / Month</div><div className="value debit">{money(monthlyTotal)}</div><div className="muted" style={{ fontSize: 11 }}>estimated from billed history</div></div>
        <div className="card stat"><div className="label">Cost / Year</div><div className="value debit">{money(yearlyTotal)}</div></div>
        <div className="card stat">
          <div className="label">Outstanding</div>
          <div className="value debit">{money(outstanding)}</div>
          <div className="muted" style={{ fontSize: 11 }}>{unpaidCount} unpaid{nextDue ? ` · next due ${shortDate(nextDue)}` : ''}</div>
        </div>
      </div>

      {hasCharts && (
        <div style={{ marginBottom: 18 }}>
          {showCharts && (
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
              <button className={chartView === 'monthly' ? '' : 'ghost'} style={CHIP} onClick={() => setChartView('monthly')}>Monthly</button>
              <button className={chartView === 'yearly' ? '' : 'ghost'} style={CHIP} onClick={() => setChartView('yearly')}>Yearly</button>
            </div>
          )}
          {showCharts && (
          <div className="grid grid-2">
            <div className="card">
              <div className="label" style={{ marginBottom: 8 }}>{viewWord} Cost by Type</div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={spendByType} dataKey="value" nameKey="label" innerRadius={52} outerRadius={84} paddingAngle={2} stroke="none">
                      {spendByType.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      <Label position="center" value={money(typeTotal)} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 600, fill: '#23262B' }} />
                    </Pie>
                    <Tooltip formatter={(v: number) => money(v)} contentStyle={chartTooltip} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} formatter={(value, entry: any) => `${value} · ${money(entry?.payload?.value ?? 0)}`} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <div className="label" style={{ marginBottom: 8 }}>{viewWord} Cost by Account{viewAccounts.length > 8 ? ' (top 8)' : ''}</div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={spendByAccount} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                    <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + v} />
                    <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: number) => [money(v), chartView === 'yearly' ? 'per year' : 'per month']} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                    <Bar dataKey="value" fill="#5A6F87" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          )}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 10px' }}>
        <h2 className="section" style={{ margin: 0 }}>Accounts{activeAccounts.length ? ` · ${activeAccounts.length}` : ''}</h2>
        {activeAccounts.length > 0 && <button className="ghost" onClick={toggleAccounts}>{showAccounts ? 'Hide Accounts' : 'Show Accounts'}</button>}
      </div>

      {activeAccounts.length === 0 ? (
        <div className="card"><div className="empty">{accounts.length === 0 ? 'No utility accounts yet. Add one to start.' : 'No active accounts for this property.'}</div></div>
      ) : showAccounts && (
        <div style={{ display: 'grid', gap: 16 }}>
          {activeAccounts.map((a, i) => {
            const monthly = monthlyForAccount(a);
            const facts: [string, string][] = [];
            if (a.account_number) facts.push(['Account #', a.account_number]);
            if (a.due_day != null) facts.push(['Due day', ordinal(a.due_day)]);
            return (
              <div key={a.id}
                className="card kindcard expense clickable"
                style={{ cursor: 'pointer', ...(acctDragIdx === i ? { opacity: 0.5 } : {}) }}
                onClick={() => navigate(`/utilities/${a.id}`)}
                onDragOver={(e) => { if (acctDragIdx !== null) e.preventDefault(); }}
                onDrop={() => { if (acctDragIdx !== null && acctDragIdx !== i) reorderAccounts(acctDragIdx, i); setAcctDragIdx(null); }}
                title="View account details">
                <div className="kindcard-head">
                  <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                    <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                      <DragHandle index={i} onStart={setAcctDragIdx} onEnd={() => setAcctDragIdx(null)} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {a.name}
                        <span className="tag">{cap(a.utility_type)}</span>
                        {Number(a.unpaid_amount) > 0 && (
                          <span className="tag" style={{ color: 'var(--debit)', borderColor: 'var(--debit)' }}>{a.unpaid_count} unpaid</span>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {a.provider && a.provider !== a.name ? `${a.provider} · ` : ''}{cap(a.billing_cycle)}{a.property_name ? ` · ${a.property_name}` : ''}
                      </div>
                    </div>
                  </div>
                  <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/utilities/${a.id}`); }}>View Details →</button>
                </div>

                <div style={{ padding: '12px 14px' }}>
                  <div className="grid grid-3" style={{ marginBottom: facts.length ? 8 : 0 }}>
                    <div className="stat"><div className="label">~ / Month</div><div className="value small">{monthly > 0 ? money(monthly) : '—'}</div></div>
                    <div className="stat"><div className="label">Outstanding</div><div className={`value small ${Number(a.unpaid_amount) > 0 ? 'debit' : ''}`}>{money(a.unpaid_amount)}</div></div>
                    <div className="stat"><div className="label">Total Billed</div><div className="value small">{money(a.total_billed)}</div><div className="muted" style={{ fontSize: 11 }}>{a.invoice_count} invoice{a.invoice_count === 1 ? '' : 's'}</div></div>
                  </div>
                  {facts.map(([k, v]) => (
                    <div key={k} className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                      <span className="muted">{k}</span><span className="num">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {disabledAccounts.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '22px 0 8px' }}>
            <div className="label" style={{ margin: 0 }}>Disabled Accounts · {disabledAccounts.length}</div>
            <button className="ghost" onClick={toggleDisabled}>{showDisabled ? 'Hide' : 'Show'}</button>
          </div>
          {showDisabled && (
            <div style={{ display: 'grid', gap: 16 }}>
              {disabledAccounts.map((a) => (
                <div key={a.id} className="card kindcard clickable" style={{ cursor: 'pointer', opacity: 0.8 }}
                  onClick={() => navigate(`/utilities/${a.id}`)} title="View account details">
                  <div className="kindcard-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {a.name}
                        <span className="tag">{cap(a.utility_type)}</span>
                        <span className="tag" style={{ color: 'var(--muted)' }}>Canceled</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {a.provider && a.provider !== a.name ? `${a.provider} · ` : ''}{cap(a.billing_cycle)}{a.property_name ? ` · ${a.property_name}` : ''}
                      </div>
                    </div>
                    <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/utilities/${a.id}`); }}>View Details →</button>
                  </div>
                  <div style={{ padding: '12px 14px' }}>
                    <div className="grid grid-3">
                      <div className="stat"><div className="label">Total Billed</div><div className="value small">{money(a.total_billed)}</div></div>
                      <div className="stat"><div className="label">Invoices</div><div className="value small">{a.invoice_count}</div></div>
                      <div className="stat"><div className="label">Ended</div><div className="value small">{a.end_date ? shortDate(a.end_date) : '—'}</div></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 28 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 className="section" style={{ margin: 0 }}>Invoices</h2>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="ghost" style={CHIP} onClick={() => setFiltersOpen((o) => !o)}>
              {filtersOpen ? '▾' : '▸'} Filter{!filtersOpen && filtersActive ? ` (${(acctFilter ? 1 : 0) + (range !== 'all' ? 1 : 0) + advCount})` : ''}
            </button>
            <button onClick={() => setAddInvoice(true)} disabled={accounts.length === 0}>Add Invoice</button>
          </div>
        </div>

        {filtersOpen && (
          <div className="card" style={{ marginBottom: 12 }}>
            {viewAccounts.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Account</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <button className={selectedAcctIds.length === 0 ? '' : 'ghost'} style={CHIP} onClick={() => setAcctFilter('')}>All</button>
                  {viewAccounts.map((a) => (
                    <button key={a.id} className={selectedAcctIds.includes(a.id) ? '' : 'ghost'} style={CHIP} onClick={() => toggleAcct(a.id)}>{a.name}</button>
                  ))}
                </div>
              </div>
            )}

            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Date range</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {RANGES.map(([k, label]) => (
                <button key={k} className={range === k ? '' : 'ghost'} style={CHIP} onClick={() => setRange(k)}>{label}</button>
              ))}
            </div>
            {range === 'custom' && (
              <div className="grid grid-3" style={{ alignItems: 'end', marginTop: 10 }}>
                <Field label="From"><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></Field>
                <Field label="To"><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></Field>
              </div>
            )}

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <button className="ghost" style={CHIP} onClick={() => setAdvancedOpen((o) => !o)}>
                {advancedOpen ? '▾' : '▸'} Amount{!advancedOpen && advCount > 0 ? ` (${advCount})` : ''}
              </button>
              {filtersActive && <button className="ghost" style={CHIP} onClick={clearFilters}>Clear Filters</button>}
            </div>
            {advancedOpen && (
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                <select value={amountOp} style={{ width: 'auto' }} onChange={(e) => setAmountOp(e.target.value)}>
                  {AMOUNT_OPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                {amountOp && amountOp !== 'between' && (
                  <AmountInput value={amount} placeholder="0.00" style={{ width: 130, textAlign: 'right' }} onChange={(v) => setAmount(v)} />
                )}
                {amountOp === 'between' && (
                  <>
                    <AmountInput value={amount} placeholder="min" style={{ width: 110, textAlign: 'right' }} onChange={(v) => setAmount(v)} />
                    <span className="muted">and</span>
                    <AmountInput value={amountMax} placeholder="max" style={{ width: 110, textAlign: 'right' }} onChange={(v) => setAmountMax(v)} />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="label" style={{ margin: '4px 0 6px' }}>Unpaid Invoices</div>
        <div style={{ marginBottom: 20 }}>
          <UnpaidInvoiceTable items={unpaidInvoices} onEdit={setEditInvoice}
            emptyText={invoices.length === 0 ? 'No invoices yet. Add one to start.' : 'No unpaid invoices. 🎉'} />
        </div>

        <div className="label" style={{ margin: '4px 0 6px' }}>Paid Invoices</div>
        <PaidInvoiceTable items={pagePaid} onEdit={setEditInvoice} />
        {invPageCount > 1 && (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <span className="muted num" style={{ fontSize: 13 }}>Showing {invStart + 1}–{invStart + pagePaid.length} of {paidInvoices.length}</span>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button className="ghost" style={CHIP} disabled={invSafePage === 0} onClick={() => setInvPage(Math.max(0, invSafePage - 1))}>Previous</button>
              <span className="muted num" style={{ fontSize: 13 }}>Page {invSafePage + 1} of {invPageCount}</span>
              <button className="ghost" style={CHIP} disabled={invSafePage >= invPageCount - 1} onClick={() => setInvPage(Math.min(invPageCount - 1, invSafePage + 1))}>Next</button>
            </div>
          </div>
        )}
      </div>

      {(addInvoice || editInvoice) && (
        <InvoiceEditor invoice={editInvoice} accounts={accounts} bankAccounts={bankAccounts}
          onClose={() => { setAddInvoice(false); setEditInvoice(null); }}
          onSaved={() => { setAddInvoice(false); setEditInvoice(null); load(); }} />
      )}
    </>
  );
}
