import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Area, AreaChart, PieChart, Pie, Cell, Label, BarChart, Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, money, shortDate } from '../api';
import { CHART_COLORS, chartTooltip, Loading } from '../components/ui';
import { ColumnBar } from '../components/ColumnBar';

interface Dash {
  netWorth: number;
  assets: number;
  liabilities: number;
  series: { date: string; net_worth: number }[];
  monthFlow: { direction: string; total: number }[];
  categorySpend: { name: string; total: number }[];
}
interface Group { type: string; label: string; total: number; count: number }
interface NetWorth { assetGroups: Group[] }
interface OverTime { series: { date: string; assets: number; liabilities: number; net_worth: number }[] }
interface CashFlow { series: { month: string; income: number; expense: number; net: number }[] }
interface Reminder { kind: string; title: string; subtitle: string | null; date: string; amount: number | null; link: string }

const KIND_LABEL: Record<string, string> = {
  renewal: 'Renewal', bill_due: 'Bill Due', payment_due: 'Payment Due', insurance_renewal: 'Insurance',
  maintenance: 'Maintenance', lease_end: 'Lease', cancels: 'Cancels', closes: 'Closes',
};
const daysUntil = (iso: string) => Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
const dueLabel = (d: number) => (d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d}d`);

export default function Dashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [nwSeries, setNwSeries] = useState<OverTime['series']>([]);
  const [flowSeries, setFlowSeries] = useState<CashFlow['series']>([]);
  const [todos, setTodos] = useState<{ setupOpen: number; attention: { kind: string; title: string; count: number; link: string; severity: string }[] } | null>(null);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Dash>('/dashboard').then(setD).catch((e) => setErr(e.message));
    api.get<{ setupOpen: number; attention: any[] }>('/todos').then(setTodos).catch(() => {});
    api.get<NetWorth>('/networth').then((n) => setGroups(n.assetGroups ?? [])).catch(() => {});
    api.get<Reminder[]>('/reminders').then(setReminders).catch(() => {});
    api.get<OverTime>('/networth/over-time').then((r) => setNwSeries(r.series ?? [])).catch(() => {});
    api.get<CashFlow>('/networth/cash-flow?months=12').then((r) => setFlowSeries(r.series ?? [])).catch(() => {});
  }, []);

  if (err) return <div className="error">{err}</div>;
  if (!d) return <Loading />;

  // Prefer the snapshot-based net-worth series (consistent with the Asset/Liability
  // dashboards); fall back to the flow-derived series when there's no dated data yet.
  const series = (nwSeries.length > 1
    ? nwSeries.map((s) => ({ date: s.date.slice(0, 10), net: Number(s.net_worth) }))
    : d.series.map((s) => ({ date: s.date.slice(0, 10), net: Number(s.net_worth) })));
  const first = series[0]?.net ?? 0;
  const last = series[series.length - 1]?.net ?? d.netWorth;
  const delta = last - first;
  const income = d.monthFlow.find((f) => f.direction === 'income')?.total ?? 0;
  const expense = d.monthFlow.find((f) => f.direction === 'expense')?.total ?? 0;
  const monthNet = Number(income) - Number(expense);

  const flow = flowSeries.map((f) => ({
    month: f.month,
    label: new Date(f.month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    income: Math.round(Number(f.income) * 100) / 100,
    expense: Math.round(Number(f.expense) * 100) / 100,
    net: Math.round(Number(f.net) * 100) / 100,
  }));
  const flowMonths = flow.length;
  const avgNet = flowMonths ? flow.reduce((s, f) => s + f.net, 0) / flowMonths : 0;

  const alloc = groups.filter((g) => g.total > 0).map((g) => ({ label: g.label, value: Math.round(g.total * 100) / 100 }));
  const spend = (d.categorySpend ?? []).map((c) => ({ name: c.name, value: Math.round(Number(c.total) * 100) / 100 }));
  const upcoming = reminders.slice(0, 6);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Overview</div>
          <h1 className="title">Dashboard</h1>
          <p className="subtitle">Your financial position at a glance — net worth over time, what you own and owe, where money went this month, and what's coming due.</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <Link to="/assets"><button className="ghost" style={{ whiteSpace: 'nowrap' }}>Asset Dashboard</button></Link>
          <Link to="/liabilities"><button className="ghost" style={{ whiteSpace: 'nowrap' }}>Liability Dashboard</button></Link>
        </div>
      </div>

      {todos && (todos.setupOpen > 0 || todos.attention.length > 0) && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--brass)' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="label" style={{ marginRight: 4 }}>Action items</span>
              {todos.setupOpen > 0 && (
                <button className="tag" style={{ cursor: 'pointer', fontSize: 12 }} onClick={() => navigate('/reminders')}>Finish setup · {todos.setupOpen} left</button>
              )}
              {todos.attention.map((a) => (
                <button key={a.kind} className="tag" style={{ cursor: 'pointer', fontSize: 12, color: a.severity === 'debit' ? 'var(--debit)' : a.severity === 'warn' ? 'var(--warn, #b8860b)' : 'var(--brass-deep)' }} onClick={() => navigate(a.link)}>{a.title}</button>
              ))}
            </div>
            <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => navigate('/reminders')}>View To-Do →</button>
          </div>
        </div>
      )}

      <div className="hero">
        <div className="label muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 12 }}>Net worth</div>
        <div>
          <span className="hero-value num">{money(d.netWorth)}</span>
          {series.length > 1 && (
            <span className={`hero-delta num ${delta >= 0 ? 'credit' : 'debit'}`}>
              {delta >= 0 ? '▲' : '▼'} {money(Math.abs(delta))} over {series.length} points
            </span>
          )}
        </div>
        <div style={{ height: 200, marginTop: 8, marginLeft: -10 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
              <defs>
                <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6B7F6E" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#6B7F6E" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false}
                tickFormatter={(v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} minTickGap={40} />
              <YAxis tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} width={56}
                tickFormatter={(v) => '$' + (v / 1000).toFixed(0) + 'k'} domain={['dataMin - 2000', 'dataMax + 2000']} />
              <Tooltip formatter={(v: number) => [money(v), 'Net worth']} labelFormatter={(l) => shortDate(l as string)} contentStyle={chartTooltip} />
              <Area type="monotone" dataKey="net" stroke="#6B7F6E" strokeWidth={2} fill="url(#nw)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="card stat clickable" style={{ cursor: 'pointer' }} onClick={() => navigate('/assets')} title="Open Asset Dashboard">
          <div className="label">Total Assets</div><div className="value credit">{money(d.assets)}</div>
        </div>
        <div className="card stat clickable" style={{ cursor: 'pointer' }} onClick={() => navigate('/liabilities')} title="Open Liability Dashboard">
          <div className="label">Total Liabilities</div><div className="value debit">{money(d.liabilities)}</div>
        </div>
        <div className="card stat">
          <div className="label">This Month · Net</div>
          <div className={`value ${monthNet >= 0 ? 'credit' : 'debit'}`}>{money(monthNet)}</div>
          <div className="muted num" style={{ fontSize: 12, marginTop: 4 }}>+{money(Number(income))} in · −{money(Number(expense))} out</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="label" style={{ marginBottom: 8 }}>Assets by Type</div>
          {alloc.length === 0 ? <div className="empty">No assets tracked yet.</div> : (
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={alloc} dataKey="value" nameKey="label" innerRadius={52} outerRadius={84} paddingAngle={2} stroke="none">
                    {alloc.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    <Label position="center" value={money(d.assets)} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 600, fill: '#23262B' }} />
                  </Pie>
                  <Tooltip formatter={(v: number) => money(v)} contentStyle={chartTooltip} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <div className="label" style={{ marginBottom: 8 }}>Spending by Category · This Month</div>
          {spend.length === 0 ? <div className="empty">No spending recorded this month.</div> : (
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={spend} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + Math.round(v)} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v: number) => [money(v), 'Spent']} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="#A15648" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div className="label">Cash Flow · Last {flowMonths || 12} Months</div>
          {flowMonths > 0 && (
            <span className="muted num" style={{ fontSize: 12 }}>avg net {avgNet >= 0 ? '+' : '−'}{money(Math.abs(avgNet))}/mo</span>
          )}
        </div>
        {flow.length === 0 ? <div className="empty">No income or expenses recorded yet.</div> : (
          <div style={{ height: 240, marginLeft: -10 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={flow} margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} width={56}
                  tickFormatter={(v) => '$' + (v / 1000).toFixed(0) + 'k'} />
                <Tooltip formatter={(v: number, n: string) => [money(v), n.charAt(0).toUpperCase() + n.slice(1)]} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                <Bar dataKey="income" name="Income" fill="#6B7F6E" shape={<ColumnBar />} maxBarSize={26} />
                <Bar dataKey="expense" name="Expense" fill="#A15648" shape={<ColumnBar />} maxBarSize={26} />
                <Line type="monotone" dataKey="net" name="Net" stroke="#23262B" strokeWidth={2} dot={{ r: 2.5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {upcoming.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '20px 0 8px' }}>
            <h2 className="section" style={{ margin: 0 }}>Upcoming</h2>
            <Link to="/reminders" className="muted" style={{ fontSize: 13 }}>All reminders →</Link>
          </div>
          <div className="card" style={{ padding: 0 }}>
            {upcoming.map((r, i) => {
              const du = daysUntil(r.date);
              return (
                <div key={`${r.link}-${r.kind}-${i}`} className="row clickable" onClick={() => navigate(r.link)}
                  style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', borderTop: i > 0 ? '1px solid var(--hairline)' : 'none' }}>
                  <div className="row" style={{ gap: 10, minWidth: 0, alignItems: 'center' }}>
                    <span className="tag" style={{ fontSize: 11, textTransform: 'none' }}>{KIND_LABEL[r.kind] ?? r.kind}</span>
                    <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                    {r.subtitle && <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.subtitle}</span>}
                  </div>
                  <div className="row" style={{ gap: 14, alignItems: 'center', flexShrink: 0 }}>
                    {r.amount != null && <span className="num">{money(r.amount)}</span>}
                    <span className="num" style={{ fontSize: 12, whiteSpace: 'nowrap', color: du < 0 ? 'var(--debit)' : du <= 7 ? 'var(--warn, #b8860b)' : 'var(--muted)' }}>{shortDate(r.date)} · {dueLabel(du)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
