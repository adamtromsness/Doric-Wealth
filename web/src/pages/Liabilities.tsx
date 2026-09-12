import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate } from '../api';
import { chartTooltip, Loading } from '../components/ui';

interface NetWorth { totals: { assets: number; liabilities: number; netWorth: number } }
interface Point { date: string; value: number }

// Liability types in display order, each a distinct red/orange/brown shade so the
// allocation chart is actually readable.
const TYPES = [
  { key: 'credit_card', label: 'Credit Cards', color: '#A15648' },
  { key: 'mortgage', label: 'Mortgages', color: '#b56a4f' },
  { key: 'auto_loan', label: 'Auto Loans', color: '#c9824f' },
  { key: 'student_loan', label: 'Student Loans', color: '#d59a5a' },
  { key: 'personal_loan', label: 'Personal Loans', color: '#b08a63' },
  { key: 'loan', label: 'Loans', color: '#a3674a' },
  { key: 'medical', label: 'Medical Debt', color: '#caa06a' },
  { key: 'other', label: 'Other', color: '#b9a890' },
] as const;
type TypeKey = typeof TYPES[number]['key'];
const typeColor = (k: TypeKey) => TYPES.find((t) => t.key === k)?.color ?? '#A15648';
const accountTypeKey = (t: string): TypeKey => (t === 'credit_card' ? 'credit_card' : t === 'mortgage' ? 'mortgage' : 'loan');
const liabTypeKey = (t: string): TypeKey => (TYPES.some((x) => x.key === t) ? (t as TypeKey) : 'other');

interface Item { id: number; name: string; value: number; type: TypeKey; sub: string; link: string }

export default function Liabilities() {
  const [nw, setNw] = useState<NetWorth | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Point[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('liabilities.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('liabilities.hideCharts', v ? '1' : '0'); return !v; });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('liabilities.collapsed') || '{}'); } catch { return {}; } });
  const toggleCollapse = (k: string) => setCollapsed((prev) => { const next = { ...prev, [k]: !prev[k] }; localStorage.setItem('liabilities.collapsed', JSON.stringify(next)); return next; });
  // Clicking a KPI tile expands its group and scrolls to it.
  const goToGroup = (k: string) => {
    setCollapsed((prev) => { const next = { ...prev, [k]: false }; localStorage.setItem('liabilities.collapsed', JSON.stringify(next)); return next; });
    setTimeout(() => document.getElementById(`liab-group-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  useEffect(() => {
    Promise.all([
      api.get<NetWorth>('/networth'),
      api.get<any[]>('/accounts').catch(() => []),
      api.get<any[]>('/properties').catch(() => []),
      api.get<any[]>('/liabilities').catch(() => []),
      api.get<any[]>('/vehicles').catch(() => []),
      api.get<{ series: Point[] }>('/networth/liability-history').catch(() => ({ series: [] })),
    ]).then(([net, accounts, properties, liabs, vehicles, hist]) => {
      setNw(net);
      setHistory((hist.series ?? []).map((p) => ({ date: p.date, value: Number(p.value) })));
      // A liability account linked to a tracked vehicle/property is that vehicle's
      // loan / that property's mortgage — classify and label it accordingly.
      const vehByLoan = new Map<number, any>();
      for (const v of vehicles) if (v.loan_account_id) vehByLoan.set(Number(v.loan_account_id), v);
      const propByMortgage = new Map<number, any>();
      for (const p of properties) if (p.mortgage_account_id) propByMortgage.set(Number(p.mortgage_account_id), p);
      const list: Item[] = [];
      for (const a of accounts) {
        if (!a.is_liability || (a.status ?? 'active') !== 'active') continue;
        const veh = vehByLoan.get(a.id);
        const prop = propByMortgage.get(a.id);
        const type: TypeKey = veh ? 'auto_loan' : prop ? 'mortgage' : accountTypeKey(a.type);
        const sub = veh ? `Vehicle · ${veh.name}` : prop ? `Property · ${prop.name}` : 'Account';
        list.push({ id: a.id, name: a.name, value: Number(a.posted_balance ?? 0), type, sub, link: `/accounts/${a.id}` });
      }
      for (const p of properties) {
        if (p.disposed_at || p.mortgage_account_id || !(Number(p.mortgage_balance ?? 0) > 0)) continue;
        list.push({ id: p.id, name: p.name, value: Number(p.mortgage_balance), type: 'mortgage', sub: 'Property', link: `/properties/${p.id}` });
      }
      for (const l of liabs) {
        list.push({ id: l.id, name: l.name, value: Number(l.balance ?? 0), type: liabTypeKey(l.liability_type), sub: 'Standalone', link: `/other-liabilities/${l.id}` });
      }
      setItems(list);
      setLoaded(true);
    }).catch((e) => { setErr(e.message); setLoaded(true); });
  }, []);

  const byType = useMemo(() => TYPES.map((t) => {
    const list = items.filter((i) => i.type === t.key);
    return { ...t, total: list.reduce((s, i) => s + i.value, 0), count: list.length };
  }).filter((t) => t.count > 0), [items]);
  const total = useMemo(() => byType.reduce((s, t) => s + t.total, 0), [byType]);
  const allocation = byType.filter((t) => t.total > 0).map((t) => ({ label: t.label, value: Math.round(t.total * 100) / 100, color: t.color }));
  const largest = useMemo(() => [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value).slice(0, 8), [items]);
  const headlineTotal = nw ? nw.totals.liabilities : total;
  const hasCharts = total > 0 || history.length >= 2;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Liabilities</div>
          <h1 className="title">Liability Dashboard</h1>
          <p className="subtitle">Everything you owe — credit, loans, mortgages, and other debts — grouped by type. Click any liability to open it.</p>
        </div>
      </div>

      {err && <div className="error">{err}</div>}
      {!loaded ? <Loading card /> : (
        <>
          {/* Per-type KPI tiles. */}
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            {byType.map((t) => (
              <div key={t.key} className="card stat clickable" style={{ cursor: 'pointer', borderTop: `3px solid ${t.color}` }} onClick={() => goToGroup(t.key)} title={`Jump to ${t.label}`}>
                <div className="label">{t.label}</div>
                <div className="value small debit">{money(t.total)}</div>
                <div className="muted num" style={{ fontSize: 12, marginTop: 4 }}>
                  {t.count} item{t.count === 1 ? '' : 's'}{total > 0 ? ` · ${Math.round((t.total / total) * 100)}%` : ''}
                </div>
              </div>
            ))}
          </div>

          {hasCharts && (
            <div className="row" style={{ justifyContent: 'flex-start', marginBottom: 12 }}>
              <button className="ghost" onClick={toggleCharts}>{showCharts ? 'Hide Charts' : 'Show Charts'}</button>
            </div>
          )}

          {showCharts && hasCharts && (
            <>
              {history.length >= 2 && (
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="label" style={{ marginBottom: 8 }}>Balance Owed Over Time</div>
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={history} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(d: string) => shortDate(d)} minTickGap={24} />
                        <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => '$' + Math.round(v / 1000) + 'k'} />
                        <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [money(Number(v)), 'Owed']} labelFormatter={(d) => shortDate(String(d))} />
                        <Area type="monotone" dataKey="value" stroke="#A15648" fill="#A15648" fillOpacity={0.15} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {total > 0 && (
                <div className="grid grid-2" style={{ marginBottom: 18 }}>
                  <div className="card">
                    <div className="label" style={{ marginBottom: 8 }}>Allocation by Type</div>
                    <div style={{ height: 240 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={allocation} dataKey="value" nameKey="label" innerRadius={52} outerRadius={84} paddingAngle={2} stroke="none">
                            {allocation.map((a, i) => <Cell key={i} fill={a.color} />)}
                            <Label position="center" value={money(headlineTotal)} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 600, fill: '#23262B' }} />
                          </Pie>
                          <Tooltip formatter={(v: number) => money(v)} contentStyle={chartTooltip} />
                          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} formatter={(value, entry: any) => `${value} · ${money(entry?.payload?.value ?? 0)}`} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="card">
                    <div className="label" style={{ marginBottom: 8 }}>Largest Debts</div>
                    <div style={{ height: 240 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={largest} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                          <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + Math.round(v / 1000) + 'k'} />
                          <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                          <Tooltip formatter={(v: number) => [money(v), 'Owed']} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                            {largest.map((it, i) => <Cell key={i} fill={typeColor(it.type)} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Compact, collapsible liability lists grouped by type. */}
          {items.length === 0 ? (
            <div className="card"><div className="empty">No liabilities tracked yet. Add liability accounts or other debts to see them here.</div></div>
          ) : byType.map((t) => {
            const list = items.filter((i) => i.type === t.key).sort((a, b) => b.value - a.value);
            const open = !collapsed[t.key];
            return (
              <div key={t.key} id={`liab-group-${t.key}`} style={{ marginBottom: 14, scrollMarginTop: 12 }}>
                <div className="row clickable" onClick={() => toggleCollapse(t.key)}
                  style={{ justifyContent: 'space-between', alignItems: 'baseline', cursor: 'pointer', padding: '4px 0' }}>
                  <h2 className="section" style={{ margin: 0 }}>{open ? '▾' : '▸'} {t.label} · {t.count}</h2>
                  <span className="muted num" style={{ fontSize: 13 }}>{money(t.total)}</span>
                </div>
                {open && (
                  <div className="card" style={{ padding: 0, marginTop: 6 }}>
                    {list.map((it, i) => (
                      <div key={`${it.type}-${it.sub}-${it.id}`} className="row clickable"
                        onClick={() => navigate(it.link)} title={`Open ${it.name}`}
                        style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 14px', cursor: 'pointer', borderTop: i > 0 ? '1px solid var(--hairline)' : 'none' }}>
                        <div className="row" style={{ gap: 10, minWidth: 0, alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{it.sub}</span>
                        </div>
                        <div className="row" style={{ gap: 14, alignItems: 'center', flexShrink: 0 }}>
                          <span className="num debit" style={{ fontWeight: 600 }}>{money(it.value)}</span>
                          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>View Details →</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="muted" style={{ fontSize: 13, marginTop: 18 }}>
            Manage each kind on its own page:{' '}
            <Link to="/liability-accounts">Liability Accounts</Link> · <Link to="/other-liabilities">Other Liabilities</Link>.
          </div>
        </>
      )}
    </>
  );
}
