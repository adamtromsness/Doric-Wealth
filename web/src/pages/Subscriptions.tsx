import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Label, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { api, money, shortDate, todayStr, parseLocalDate } from '../api';
import { Field, Modal, DragHandle, arrayMove, slotReorder, CHART_COLORS, chartTooltip, CHIP, cap, EditorFooter, AmountInput } from '../components/ui';
import { SubscriptionSuggestions, type SubscriptionSuggestion } from '../components/SubscriptionSuggestions';

export interface Account { id: number; name: string; type?: string; archived_at?: string | null }
export interface Subscription {
  id: number;
  name: string;
  amount: number;
  billing_cycle: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  next_due_date: string | null;
  category_id: number | null;
  account_id: number | null;
  status: 'active' | 'paused' | 'canceled';
  start_date: string | null;
  notes: string | null;
  tier: string | null;
  service_type: string | null;
  end_date: string | null;
  login_url: string | null;
  login_id: string | null;
  website_url: string | null;
  phone: string | null;
  category_name: string | null;
  account_name: string | null;
  monthly_amount: number;
  doc_count: number;
}
interface Summary {
  activeCount: number;
  monthlyTotal: number;
  yearlyTotal: number;
  upcoming: Subscription[];
}
export interface Charge {
  sub_id: number; id: number; txn_date: string | null; posted_date: string | null;
  amount: number; merchant: string | null; description: string | null; account_name: string | null;
}

export const CYCLES: Subscription['billing_cycle'][] = ['weekly', 'monthly', 'quarterly', 'yearly'];

// What kind of service a subscription is.
export const SERVICE_TYPES: [string, string][] = [
  ['streaming', 'TV / Streaming'], ['music', 'Music'], ['software', 'Software'],
  ['gaming', 'Gaming'], ['cloud', 'Cloud Storage'], ['news', 'News & Magazines'],
  ['fitness', 'Fitness'], ['phone', 'Phone / Mobile'], ['membership', 'Membership'], ['other', 'Other'],
];
export const serviceTypeLabel = (t: string | null) => (t ? SERVICE_TYPES.find(([v]) => v === t)?.[1] ?? t : '—');
// Default type for each quick-fill service.
export const PRESET_TYPE: Record<string, string> = {
  Netflix: 'streaming', Spotify: 'music', 'Disney+': 'streaming', Hulu: 'streaming', Max: 'streaming',
  'Amazon Prime': 'membership', 'YouTube Premium': 'streaming', 'Apple Music': 'music', 'Apple One': 'other',
  'iCloud+': 'cloud', 'Google One': 'cloud', 'Paramount+': 'streaming', Peacock: 'streaming',
  'Microsoft 365': 'software', 'Adobe Creative Cloud': 'software', 'ChatGPT Plus': 'software',
  'Xbox Game Pass': 'gaming', 'PlayStation Plus': 'gaming', Costco: 'membership', 'Planet Fitness': 'fitness',
};

// Quick-fill catalog of common services. Prices are approximate US starting
// points (editable after you pick one). cycle defaults to 'monthly'.
export interface PresetTier { tier: string; amount: number; cycle?: Subscription['billing_cycle'] }
export interface ServicePreset { name: string; tiers: PresetTier[] }
export const SERVICE_PRESETS: ServicePreset[] = [
  { name: 'Netflix', tiers: [{ tier: 'Standard with ads', amount: 7.99 }, { tier: 'Standard', amount: 17.99 }, { tier: 'Premium 4K', amount: 24.99 }] },
  { name: 'Spotify', tiers: [{ tier: 'Student', amount: 5.99 }, { tier: 'Individual', amount: 11.99 }, { tier: 'Duo', amount: 16.99 }, { tier: 'Family', amount: 19.99 }] },
  { name: 'Disney+', tiers: [{ tier: 'Basic (ads)', amount: 9.99 }, { tier: 'Premium', amount: 15.99 }] },
  { name: 'Hulu', tiers: [{ tier: 'With ads', amount: 9.99 }, { tier: 'No ads', amount: 18.99 }] },
  { name: 'Max', tiers: [{ tier: 'With ads', amount: 9.99 }, { tier: 'Ad-free', amount: 16.99 }, { tier: 'Ultimate', amount: 20.99 }] },
  { name: 'Amazon Prime', tiers: [{ tier: 'Monthly', amount: 14.99 }, { tier: 'Annual', amount: 139, cycle: 'yearly' }] },
  { name: 'YouTube Premium', tiers: [{ tier: 'Student', amount: 7.99 }, { tier: 'Individual', amount: 13.99 }, { tier: 'Family', amount: 22.99 }] },
  { name: 'Apple Music', tiers: [{ tier: 'Student', amount: 5.99 }, { tier: 'Individual', amount: 10.99 }, { tier: 'Family', amount: 16.99 }] },
  { name: 'Apple One', tiers: [{ tier: 'Individual', amount: 19.95 }, { tier: 'Family', amount: 25.95 }, { tier: 'Premier', amount: 37.95 }] },
  { name: 'iCloud+', tiers: [{ tier: '50GB', amount: 0.99 }, { tier: '200GB', amount: 2.99 }, { tier: '2TB', amount: 9.99 }] },
  { name: 'Google One', tiers: [{ tier: '100GB', amount: 1.99 }, { tier: '200GB', amount: 2.99 }, { tier: '2TB', amount: 9.99 }] },
  { name: 'Paramount+', tiers: [{ tier: 'Essential', amount: 7.99 }, { tier: 'with Showtime', amount: 12.99 }] },
  { name: 'Peacock', tiers: [{ tier: 'Premium', amount: 7.99 }, { tier: 'Premium Plus', amount: 13.99 }] },
  { name: 'Microsoft 365', tiers: [{ tier: 'Personal', amount: 69.99, cycle: 'yearly' }, { tier: 'Family', amount: 99.99, cycle: 'yearly' }] },
  { name: 'Adobe Creative Cloud', tiers: [{ tier: 'Photography', amount: 9.99 }, { tier: 'All Apps', amount: 59.99 }] },
  { name: 'ChatGPT Plus', tiers: [{ tier: 'Plus', amount: 20 }, { tier: 'Pro', amount: 200 }] },
  { name: 'Xbox Game Pass', tiers: [{ tier: 'Core', amount: 9.99 }, { tier: 'Standard', amount: 14.99 }, { tier: 'Ultimate', amount: 19.99 }] },
  { name: 'PlayStation Plus', tiers: [{ tier: 'Essential', amount: 9.99 }, { tier: 'Extra', amount: 14.99 }, { tier: 'Premium', amount: 17.99 }] },
  { name: 'Costco', tiers: [{ tier: 'Gold Star', amount: 65, cycle: 'yearly' }, { tier: 'Executive', amount: 130, cycle: 'yearly' }] },
  { name: 'Planet Fitness', tiers: [{ tier: 'Classic', amount: 15 }, { tier: 'Black Card', amount: 24.99 }] },
];

const daysFromToday = (d: string) => Math.round((parseLocalDate(d).getTime() - parseLocalDate(todayStr()).getTime()) / 86400000);
export const dueClass = (d: string | null) => {
  if (!d) return '';
  const days = daysFromToday(d);
  if (days < 0) return 'debit';
  if (days <= 7) return 'warn';
  return '';
};
export const dueInLabel = (d: string | null) => {
  if (!d) return '—';
  const n = daysFromToday(d);
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
};
// Short per-cycle suffix for compact "$X/mo" style labels.
const CYCLE_SHORT: Record<string, string> = { weekly: 'wk', monthly: 'mo', quarterly: 'qtr', yearly: 'yr' };

const SUBSCRIPTION_FILTERS: [string, string][] = [
  ['active', 'Active Subscriptions'],
  ['all', 'All Subscriptions'],
  ['canceled', 'Cancelled'],
  ['paused', 'Paused'],
];

export default function Subscriptions() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [filter, setFilter] = useState('active');
  const [showPrev, setShowPrev] = useState(() => localStorage.getItem('subscriptions.showCancelled') === '1');
  const togglePrev = () => setShowPrev((s) => { localStorage.setItem('subscriptions.showCancelled', s ? '0' : '1'); return !s; });
  const [showCharts, setShowCharts] = useState(() => localStorage.getItem('subscriptions.hideCharts') !== '1');
  const toggleCharts = () => setShowCharts((v) => { localStorage.setItem('subscriptions.hideCharts', v ? '1' : '0'); return !v; });
  const [chartView, setChartView] = useState<'monthly' | 'yearly'>('monthly');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<SubscriptionSuggestion[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const load = () => {
    api.get<Subscription[]>('/subscriptions').then(setSubs).catch((e) => setErr(e.message));
    api.get<Summary>('/subscriptions/summary').then(setSummary).catch(() => {});
    api.get<SubscriptionSuggestion[]>('/subscriptions/suggestions').then(setSuggestions).catch(() => {});
  };
  useEffect(() => {
    load();
    api.get<Account[]>('/accounts').then(setAccounts).catch(() => {});
  }, []);

  const active = subs.filter((s) => s.status !== 'canceled');
  const cancelled = subs.filter((s) => s.status === 'canceled');

  // The page filter drives which subscriptions are listed.
  const matchesFilter = (s: Subscription) => {
    switch (filter) {
      case 'all': return true;
      case 'canceled': return s.status === 'canceled';
      case 'paused': return s.status === 'paused';
      case 'active': default: return s.status !== 'canceled';
    }
  };
  const filtered = subs.filter(matchesFilter);
  const includeCanceled = filter === 'all' || filter === 'canceled';
  // Drag-reorder is only meaningful for the full active list (default filter).
  const draggable = filter === 'active';
  // Separate "Cancelled" section only shows when the filter is active-focused.
  const showPrevSection = !includeCanceled && cancelled.length > 0;
  const filterLabel = SUBSCRIPTION_FILTERS.find(([v]) => v === filter)?.[1] ?? 'Subscriptions';

  // Drag-to-reorder the visible rows; persist the full list's new order.
  const reorder = async (from: number, to: number) => {
    if (from === to) return;
    const displayed = active.map((s) => s.id);
    const next = arrayMove(displayed, from, to);
    try { await api.post('/subscriptions/reorder', { ids: slotReorder(subs.map((s) => s.id), displayed, next) }); load(); } catch (e: any) { setErr(e.message); }
  };

  // Active-only spend, grouped by service type and per subscription. Scaled to a
  // monthly or yearly figure for the charts via the view toggle.
  const mult = chartView === 'yearly' ? 12 : 1;
  const viewWord = chartView === 'yearly' ? 'Yearly' : 'Monthly';
  const spendByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of subs.filter((x) => x.status === 'active')) {
      const label = s.service_type ? serviceTypeLabel(s.service_type) : 'Unspecified';
      m.set(label, (m.get(label) ?? 0) + Number(s.monthly_amount || 0) * mult);
    }
    return [...m.entries()]
      .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value);
  }, [subs, mult]);
  const spendBySub = useMemo(() =>
    subs.filter((s) => s.status === 'active')
      .map((s) => ({ name: s.name, value: Math.round(Number(s.monthly_amount || 0) * mult * 100) / 100 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    [subs, mult]
  );
  const typeTotal = spendByType.reduce((s, x) => s + x.value, 0);
  const hasCharts = spendBySub.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Track</div>
          <h1 className="title">Subscriptions</h1>
          <p className="subtitle">
            Track recurring charges that aren’t tied to a physical property — streaming, software, memberships, and the like — along with their true monthly cost.
            For property-related bills like electricity or water, use <Link to="/utilities">Utilities</Link> instead. Payments are logged from the transaction screen.
          </p>
        </div>
        <button className="head-add" onClick={() => navigate('/subscriptions/new')}>Add Subscription</button>
      </div>

      {err && <div className="error">{err}</div>}

      {suggestions.length > 0 && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: 'var(--surface-alt)' }}>
          <div>
            <strong>{suggestions.length} possible subscription{suggestions.length === 1 ? '' : 's'}</strong> found in your transactions.
            <span className="muted"> Review to confirm or ignore.</span>
          </div>
          <button style={CHIP} onClick={() => setReviewing(true)}>Review</button>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {hasCharts && <button className="ghost" onClick={toggleCharts}>{showCharts ? 'Hide Charts' : 'Show Charts'}</button>}
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>Show</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto', minWidth: 175 }}>
            {SUBSCRIPTION_FILTERS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
          </select>
        </div>
      </div>

      {summary && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <div className="card stat"><div className="label">Active Subscriptions</div><div className="value">{summary.activeCount}</div><div className="muted" style={{ fontSize: 11 }}>{money(summary.activeCount ? summary.monthlyTotal / summary.activeCount : 0)} avg / mo</div></div>
          <div className="card stat"><div className="label">Cost / Month</div><div className="value debit">{money(summary.monthlyTotal)}</div></div>
          <div className="card stat"><div className="label">Cost / Year</div><div className="value debit">{money(summary.yearlyTotal)}</div></div>
          <div className="card stat">
            <div className="label">Renewing in 30 Days</div>
            <div className="value">{summary.upcoming.length}</div>
            <div className="muted" style={{ fontSize: 11 }}>{summary.upcoming.length ? `${money(summary.upcoming.reduce((s, x) => s + Number(x.amount), 0))} due` : 'nothing due'}</div>
          </div>
        </div>
      )}

      {hasCharts && (
        <div style={{ marginBottom: 16 }}>
          {showCharts && (
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
              <button className={chartView === 'monthly' ? '' : 'ghost'} style={CHIP} onClick={() => setChartView('monthly')}>Monthly</button>
              <button className={chartView === 'yearly' ? '' : 'ghost'} style={CHIP} onClick={() => setChartView('yearly')}>Yearly</button>
            </div>
          )}
          {showCharts && (
          <div className="grid grid-2">
          <div className="card">
            <div className="label" style={{ marginBottom: 8 }}>{viewWord} Spend by Type</div>
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={spendByType} dataKey="value" nameKey="label" innerRadius={52} outerRadius={84} paddingAngle={2} stroke="none">
                    {spendByType.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    <Label position="center" value={money(typeTotal)}
                      style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: 600, fill: '#23262B' }} />
                  </Pie>
                  <Tooltip formatter={(v: number) => money(v)} contentStyle={chartTooltip} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }}
                    formatter={(value, entry: any) => `${value} · ${money(entry?.payload?.value ?? 0)}`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="card">
            <div className="label" style={{ marginBottom: 8 }}>{viewWord} Cost by Subscription{subs.filter((s) => s.status === 'active').length > 8 ? ' (top 8)' : ''}</div>
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={spendBySub} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
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

      {summary && summary.upcoming.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 8 }}>Renewing in the Next 30 Days</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {summary.upcoming.map((s) => (
              <span key={s.id} className="tag" style={{ fontSize: 12 }}>
                {s.name} · {money(s.amount)} · <span className={`num ${dueClass(s.next_due_date)}`}>{shortDate(s.next_due_date)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 10px' }}>
        <h2 className="section" style={{ margin: 0 }}>{filterLabel}</h2>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><div className="empty">{subs.length === 0 ? 'No subscriptions yet. Add one to start tracking recurring costs.' : 'No subscriptions match this filter.'}</div></div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {filtered.map((s, i) => {
            if (s.status === 'canceled') return <CancelledSubscriptionCard key={s.id} sub={s} onOpen={() => navigate(`/subscriptions/${s.id}`)} />;
            const showNext = s.status === 'active' && s.next_due_date;
            const monthly = Number(s.monthly_amount || 0);
            const total = summary?.monthlyTotal ?? 0;
            const sharePct = s.status === 'active' && total > 0 ? Math.round((monthly / total) * 100) : null;
            const facts: [string, string][] = [];
            if (sharePct != null) facts.push(['Share of monthly spend', `${sharePct}%`]);
            if (s.account_name) facts.push(['Account', s.account_name]);
            if (s.start_date) facts.push(['Member since', shortDate(s.start_date)]);
            if (s.end_date) facts.push(['Cancels', shortDate(s.end_date)]);
            return (
              <div key={s.id}
                className="card kindcard expense clickable"
                style={{ cursor: 'pointer', ...(dragIdx === i ? { opacity: 0.5 } : {}) }}
                onClick={() => navigate(`/subscriptions/${s.id}`)}
                onDragOver={(e) => { if (draggable && dragIdx !== null) e.preventDefault(); }}
                onDrop={() => { if (draggable && dragIdx !== null && dragIdx !== i) reorder(dragIdx, i); setDragIdx(null); }}
                title="View subscription details">
                <div className="kindcard-head">
                  <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                    {draggable && (
                      <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                        <DragHandle index={i} onStart={setDragIdx} onEnd={() => setDragIdx(null)} />
                      </span>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {s.name}
                        {s.tier && <span className="tag">{s.tier}</span>}
                        {s.status === 'active'
                          ? <span className="tag">Active</span>
                          : <span className="muted" style={{ fontSize: 12 }}>{cap(s.status)}</span>}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {serviceTypeLabel(s.service_type)} · {money(s.amount)}/{CYCLE_SHORT[s.billing_cycle] ?? s.billing_cycle}
                      </div>
                    </div>
                  </div>
                  <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/subscriptions/${s.id}`); }}>View Details →</button>
                </div>

                <div style={{ padding: '12px 14px' }}>
                  <div className="grid grid-3" style={{ marginBottom: facts.length ? 8 : 0 }}>
                    <div className="stat"><div className="label">Per Month</div><div className="value small">{money(s.monthly_amount)}</div></div>
                    <div className="stat"><div className="label">Per Year</div><div className="value small">{money(monthly * 12)}</div></div>
                    <div className="stat">
                      <div className="label">Next Due</div>
                      {showNext
                        ? <><div className={`value small ${dueClass(s.next_due_date)}`}>{shortDate(s.next_due_date)}</div><div className={`muted ${dueClass(s.next_due_date)}`} style={{ fontSize: 11 }}>{dueInLabel(s.next_due_date)}</div></>
                        : <div className="value small">{s.status === 'paused' ? 'Paused' : '—'}</div>}
                    </div>
                  </div>
                  {facts.map(([k, v]) => (
                    <div key={k} className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                      <span className="muted">{k}</span><span className="num">{v}</span>
                    </div>
                  ))}
                  {s.notes && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{s.notes}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showPrevSection && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '22px 0 8px' }}>
            <div className="label" style={{ margin: 0 }}>Cancelled Subscriptions · {cancelled.length}</div>
            <button className="ghost" onClick={togglePrev}>{showPrev ? 'Hide' : 'Show'}</button>
          </div>
          {showPrev && (
            <div style={{ display: 'grid', gap: 16 }}>
              {cancelled.map((s) => (
                <CancelledSubscriptionCard key={s.id} sub={s} onOpen={() => navigate(`/subscriptions/${s.id}`)} />
              ))}
            </div>
          )}
        </>
      )}

      {reviewing && (
        <SubscriptionSuggestions onClose={() => setReviewing(false)} onChanged={load} />
      )}
    </>
  );
}


// Cancelled-subscription card: the history and what it used to cost (dimmed),
// mirroring the previously-owned vehicle/property cards.
function CancelledSubscriptionCard({ sub: s, onOpen }: { sub: Subscription; onOpen: () => void }) {
  const facts: [string, string][] = [
    ['Was', `${money(s.amount)} / ${cap(s.billing_cycle).toLowerCase()}`],
    ['~ / month', money(s.monthly_amount)],
  ];
  if (s.start_date || s.end_date) facts.push(['Active', `${s.start_date ? shortDate(s.start_date) : '—'} → ${s.end_date ? shortDate(s.end_date) : '—'}`]);
  if (s.account_name) facts.push(['Account', s.account_name]);

  return (
    <div className="card kindcard expense clickable" style={{ cursor: 'pointer', opacity: 0.8 }} onClick={onOpen} title="View subscription details">
      <div className="kindcard-head">
        <div style={{ minWidth: 0 }}>
          <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {s.name}
            {s.tier && <span className="tag">{s.tier}</span>}
            <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}>Canceled</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{serviceTypeLabel(s.service_type)} · {cap(s.billing_cycle)}</div>
        </div>
        <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>View Details →</button>
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div className="row" style={{ gap: '4px 20px', flexWrap: 'wrap', fontSize: 12 }}>
          {facts.map(([k, v]) => <span key={k}><span className="muted">{k}: </span><span className="num">{v}</span></span>)}
        </div>
      </div>
    </div>
  );
}

export function SubscriptionEditor({
  sub, accounts, onClose, onSaved,
}: {
  sub: Subscription | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // A scheduled (future) cancellation is stored as active + end_date; surface it
  // as a "canceled" intent so the dropdown + date reflect what was set.
  const initStatus: Subscription['status'] = sub
    ? (sub.status === 'canceled' || sub.end_date ? 'canceled' : sub.status)
    : 'active';
  const [f, setF] = useState({
    name: sub?.name ?? '',
    amount: sub?.amount?.toString() ?? '',
    billing_cycle: sub?.billing_cycle ?? 'monthly',
    next_due_date: sub?.next_due_date?.slice(0, 10) ?? '',
    start_date: sub?.start_date?.slice(0, 10) ?? '',
    account_id: sub?.account_id?.toString() ?? '',
    status: initStatus,
    cancel_date: sub?.end_date?.slice(0, 10) ?? todayStr(),
    tier: sub?.tier ?? '',
    service_type: sub?.service_type ?? '',
    login_url: sub?.login_url ?? '',
    login_id: sub?.login_id ?? '',
    notes: sub?.notes ?? '',
  });
  const [presetName, setPresetName] = useState('');
  const [err, setErr] = useState('');

  // Enable Save/Add only once something changes from the loaded state.
  const baseline = useRef<string | null>(null);
  const snapshot = JSON.stringify(f);
  if (baseline.current === null) baseline.current = snapshot;
  const dirty = snapshot !== baseline.current;

  const selectedPreset = SERVICE_PRESETS.find((s) => s.name === presetName) ?? null;
  const applyTier = (t: PresetTier) => {
    setF((cur) => ({ ...cur, name: presetName, tier: t.tier, amount: String(t.amount), billing_cycle: t.cycle ?? 'monthly' }));
  };

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    if (!f.amount || Number(f.amount) <= 0) { setErr('Amount must be greater than 0.'); return; }
    const body = {
      name: f.name,
      amount: Number(f.amount),
      billing_cycle: f.billing_cycle,
      next_due_date: f.next_due_date || null,
      start_date: f.start_date || null,
      account_id: f.account_id ? Number(f.account_id) : null,
      status: f.status,
      end_date: f.status === 'canceled' ? (f.cancel_date || todayStr()) : null,
      tier: f.tier.trim() || null,
      service_type: f.service_type || null,
      login_url: f.login_url.trim() || null,
      login_id: f.login_id.trim() || null,
      notes: f.notes || null,
    };
    try {
      if (sub) await api.put(`/subscriptions/${sub.id}`, body);
      else await api.post('/subscriptions', body);
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  const remove = async () => {
    if (!sub || !confirm(`Delete subscription "${sub.name}"?`)) return;
    try { await api.del(`/subscriptions/${sub.id}`); onSaved(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <Modal title={sub ? 'Edit Subscription' : 'Add Subscription'} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {!sub && (
        <div className="card" style={{ padding: 12, marginBottom: 14, background: 'var(--surface-alt)' }}>
          <div className="grid grid-2">
            <Field label="Quick Fill from a Service (Optional)">
              <select value={presetName} onChange={(e) => {
                const name = e.target.value;
                setPresetName(name);
                if (PRESET_TYPE[name]) setF((cur) => ({ ...cur, service_type: cur.service_type || PRESET_TYPE[name] }));
              }}>
                <option value="">— Choose a service —</option>
                {SERVICE_PRESETS.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Plan">
              <select value="" disabled={!selectedPreset} onChange={(e) => {
                const t = selectedPreset?.tiers.find((x) => x.tier === e.target.value);
                if (t) applyTier(t);
              }}>
                <option value="">{selectedPreset ? 'Choose a plan…' : 'Pick a service first'}</option>
                {selectedPreset?.tiers.map((t) => (
                  <option key={t.tier} value={t.tier}>{t.tier} — {money(t.amount)}/{(t.cycle ?? 'monthly') === 'yearly' ? 'yr' : 'mo'}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Fills name, tier, price &amp; cycle below — prices are approximate; edit as needed.</div>
        </div>
      )}

      <div className="grid grid-3">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Netflix" /></Field>
        <Field label="Tier / Plan"><input value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} placeholder="e.g. Premium 4K, Standard, Family" /></Field>
        <Field label="Type">
          <select value={f.service_type} onChange={(e) => setF({ ...f, service_type: e.target.value })}>
            <option value="">—</option>
            {SERVICE_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-3">
        <Field label="Amount"><AmountInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} placeholder="0.00" /></Field>
        <Field label="Billing Cycle">
          <select value={f.billing_cycle} onChange={(e) => setF({ ...f, billing_cycle: e.target.value as any })}>
            {CYCLES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
          </select>
        </Field>
        <Field label="Account">
          <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
            <option value="">—</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Started"><input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
        <Field label="Next Due Date"><input type="date" value={f.next_due_date} onChange={(e) => setF({ ...f, next_due_date: e.target.value })} /></Field>
      </div>
      <div className="grid grid-2">
        <Field label="Status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Subscription['status'] })}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="canceled">Canceled</option>
          </select>
        </Field>
        {f.status === 'canceled' && (
          <Field label="Cancellation Date">
            <input type="date" value={f.cancel_date} onChange={(e) => setF({ ...f, cancel_date: e.target.value })} />
          </Field>
        )}
      </div>
      {f.status === 'canceled' && (
        <div className="muted" style={{ fontSize: 11, marginTop: -4, marginBottom: 8 }}>
          {f.cancel_date && f.cancel_date > todayStr()
            ? `Stays active until ${shortDate(f.cancel_date)}, then cancels.`
            : 'Cancels immediately.'}
        </div>
      )}
      <div className="grid grid-2">
        <Field label="Login URL"><input value={f.login_url} onChange={(e) => setF({ ...f, login_url: e.target.value })} placeholder="e.g. netflix.com/account" /></Field>
        <Field label="Login ID"><input value={f.login_id} onChange={(e) => setF({ ...f, login_id: e.target.value })} placeholder="username or email" /></Field>
      </div>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Payments are filed automatically under the auto-managed “{f.name.trim() || 'Subscriptions'}” category — log them from the transaction screen.
      </div>

      <EditorFooter onClose={onClose} onSave={save} onDelete={sub ? remove : undefined}
        saveLabel={sub ? 'Save Changes' : 'Add'} disabled={!dirty} />
    </Modal>
  );
}
