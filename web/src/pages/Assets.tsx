import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate, accountTypeLabel } from '../api';
import { chartTooltip, Loading } from '../components/ui';

interface NetWorth { totals: { assets: number; liabilities: number; netWorth: number } }
interface Point { date: string; value: number }

// The four asset categories, each with its manage page and a stable colour.
const CATS = [
  { key: 'accounts', label: 'Asset Accounts', page: '/asset-accounts', color: '#5A6F87' },
  { key: 'properties', label: 'Properties', page: '/properties', color: '#6B7F6E' },
  { key: 'vehicles', label: 'Vehicles', page: '/vehicles', color: '#B78A4A' },
  { key: 'other', label: 'Other Assets', page: '/other-assets', color: '#8A946E' },
] as const;
type CatKey = typeof CATS[number]['key'];
const catColor = (k: CatKey) => CATS.find((c) => c.key === k)!.color;
const OTHER_TYPE_LABELS: Record<string, string> = { rv: 'RV', airplane: 'Airplane', boat: 'Boat', equipment: 'Equipment', collectible: 'Collectible', other: 'Other', property: 'Property' };

interface Item { id: number; name: string; value: number; cat: CatKey; sub: string; link: string }

export default function Assets() {
  const [nw, setNw] = useState<NetWorth | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Point[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('assets.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('assets.hideCharts', v ? '1' : '0'); return !v; });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('assets.collapsed') || '{}'); } catch { return {}; } });
  const toggleCollapse = (k: string) => setCollapsed((prev) => { const next = { ...prev, [k]: !prev[k] }; localStorage.setItem('assets.collapsed', JSON.stringify(next)); return next; });

  useEffect(() => {
    Promise.all([
      api.get<NetWorth>('/networth'),
      api.get<any[]>('/accounts').catch(() => []),
      api.get<any[]>('/properties').catch(() => []),
      api.get<any[]>('/vehicles').catch(() => []),
      api.get<any[]>('/assets').catch(() => []),
      api.get<{ series: Point[] }>('/networth/asset-history').catch(() => ({ series: [] })),
    ]).then(([net, accounts, properties, vehicles, assets, hist]) => {
      setNw(net);
      setHistory((hist.series ?? []).map((p) => ({ date: p.date, value: Number(p.value) })));
      const list: Item[] = [];
      for (const a of accounts) {
        if (a.is_liability || (a.status ?? 'active') !== 'active') continue;
        list.push({ id: a.id, name: a.name, value: Number(a.posted_balance ?? 0), cat: 'accounts', sub: accountTypeLabel(a.type), link: `/accounts/${a.id}` });
      }
      for (const p of properties) { if (p.disposed_at) continue; list.push({ id: p.id, name: p.name, value: Number(p.current_value ?? 0), cat: 'properties', sub: 'Property', link: `/properties/${p.id}` }); }
      for (const v of vehicles) { if (v.disposed_at) continue; list.push({ id: v.id, name: v.name, value: Number(v.current_value ?? 0), cat: 'vehicles', sub: 'Vehicle', link: `/vehicles/${v.id}` }); }
      for (const a of assets) { list.push({ id: a.id, name: a.name, value: Number(a.value ?? 0), cat: 'other', sub: OTHER_TYPE_LABELS[a.asset_type] ?? 'Asset', link: `/other-assets/${a.id}` }); }
      setItems(list);
      setLoaded(true);
    }).catch((e) => { setErr(e.message); setLoaded(true); });
  }, []);

  const byCat = useMemo(() => CATS.map((c) => {
    const list = items.filter((i) => i.cat === c.key);
    return { ...c, total: list.reduce((s, i) => s + i.value, 0), count: list.length };
  }), [items]);
  const total = useMemo(() => byCat.reduce((s, c) => s + c.total, 0), [byCat]);
  const allocation = byCat.filter((c) => c.total > 0).map((c) => ({ label: c.label, value: Math.round(c.total * 100) / 100, color: c.color }));
  const largest = useMemo(() => [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value).slice(0, 8), [items]);
  const headlineTotal = nw ? nw.totals.assets : total;
  const hasCharts = total > 0 || history.length >= 2;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Assets</div>
          <h1 className="title">Asset Dashboard</h1>
          <p className="subtitle">Everything you own — accounts, properties, vehicles, and other assets — at a glance. Click any asset to open it.</p>
        </div>
      </div>

      {err && <div className="error">{err}</div>}
      {!loaded ? <Loading card /> : (
        <>
          {/* Category KPI tiles — click through to each manage page. */}
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            {byCat.map((c) => (
              <div key={c.key} className="card stat clickable" style={{ cursor: 'pointer', borderTop: `3px solid ${c.color}` }}
                onClick={() => navigate(c.page)} title={`Open ${c.label}`}>
                <div className="label">{c.label}</div>
                <div className="value small">{money(c.total)}</div>
                <div className="muted num" style={{ fontSize: 12, marginTop: 4 }}>
                  {c.count} item{c.count === 1 ? '' : 's'}{total > 0 ? ` · ${Math.round((c.total / total) * 100)}%` : ''}
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
                  <div className="label" style={{ marginBottom: 8 }}>Asset Value Over Time</div>
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={history} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(d: string) => shortDate(d)} minTickGap={24} />
                        <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => '$' + Math.round(v / 1000) + 'k'} />
                        <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [money(Number(v)), 'Assets']} labelFormatter={(d) => shortDate(String(d))} />
                        <Area type="monotone" dataKey="value" stroke="#6B7F6E" fill="#6B7F6E" fillOpacity={0.15} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {total > 0 && (
                <div className="grid grid-2" style={{ marginBottom: 18 }}>
                  <div className="card">
                    <div className="label" style={{ marginBottom: 8 }}>Allocation</div>
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
                    <div className="label" style={{ marginBottom: 8 }}>Largest Assets</div>
                    <div style={{ height: 240 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={largest} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                          <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + Math.round(v / 1000) + 'k'} />
                          <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                          <Tooltip formatter={(v: number) => [money(v), 'Value']} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                            {largest.map((it, i) => <Cell key={i} fill={catColor(it.cat)} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Compact, collapsible asset lists grouped by type. */}
          {items.length === 0 ? (
            <div className="card"><div className="empty">No assets tracked yet. Add accounts, properties, vehicles, or other assets to see them here.</div></div>
          ) : byCat.filter((c) => c.count > 0).map((c) => {
            const list = items.filter((i) => i.cat === c.key).sort((a, b) => b.value - a.value);
            const open = !collapsed[c.key];
            return (
              <div key={c.key} style={{ marginBottom: 14 }}>
                <div className="row clickable" onClick={() => toggleCollapse(c.key)}
                  style={{ justifyContent: 'space-between', alignItems: 'baseline', cursor: 'pointer', padding: '4px 0' }}>
                  <h2 className="section" style={{ margin: 0 }}>{open ? '▾' : '▸'} {c.label} · {c.count}</h2>
                  <span className="muted num" style={{ fontSize: 13 }}>{money(c.total)}</span>
                </div>
                {open && (
                  <div className="card" style={{ padding: 0, marginTop: 6 }}>
                    {list.map((it, i) => (
                      <div key={`${it.cat}-${it.id}`} className="row clickable"
                        onClick={() => navigate(it.link)} title={`Open ${it.name}`}
                        style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 14px', cursor: 'pointer', borderTop: i > 0 ? '1px solid var(--hairline)' : 'none' }}>
                        <div className="row" style={{ gap: 10, minWidth: 0, alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{it.sub}</span>
                        </div>
                        <div className="row" style={{ gap: 14, alignItems: 'center', flexShrink: 0 }}>
                          <span className="num" style={{ fontWeight: 600 }}>{money(it.value)}</span>
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
            <Link to="/asset-accounts">Asset Accounts</Link> · <Link to="/properties">Properties</Link> ·{' '}
            <Link to="/vehicles">Vehicles</Link> · <Link to="/other-assets">Other Assets</Link>.
          </div>
        </>
      )}
    </>
  );
}
