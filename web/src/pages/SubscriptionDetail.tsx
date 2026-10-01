import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money, shortDate, todayStr, normalizeUrl, isOpenableUrl, formatPhone } from '../api';
import { cap, BackLink, Field, AmountInput, EditorSection, Loading } from '../components/ui';
import { EntityDocuments } from '../components/EntityDocuments';
import {
  serviceTypeLabel, dueClass, dueInLabel, CYCLES, SERVICE_TYPES, SERVICE_PRESETS, PRESET_TYPE,
  type Subscription, type Charge, type Account, type PresetTier,
} from './Subscriptions';
import { isPayableFrom } from './utilities/invoiceHelpers';
import { TxnEditor } from './transactions/TxnEditor';
import { PAGE_SIZE, type Lookups, type Txn, type TxnPage } from './transactions/helpers';

type Tab = 'overview' | 'charges' | 'documents' | 'details';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'charges', label: 'Charges' },
  { key: 'documents', label: 'Documents' },
  { key: 'details', label: 'Details' },
];

// Document categories for a subscription (invoices, receipts, contracts, …).
const SUBSCRIPTION_DOC_TYPES: [string, string][] = [
  ['invoice', 'Invoice'],
  ['receipt', 'Receipt'],
  ['contract', 'Contract'],
  ['correspondence', 'Correspondence'],
  ['other', 'Other'],
];

interface PricePoint { id: number; amount: number; billing_cycle: string | null; effective_date: string }

// One charge row renderer, shared by the Overview "recent" list and the Charges tab.
function ChargeTable({ items, onEdit }: { items: Charge[]; onEdit?: (c: Charge) => void }) {
  if (items.length === 0) return <div className="empty">No charges recorded for this subscription yet. They appear here once a transaction is categorized to it.</div>;
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="ledger">
        <thead><tr><th>Date</th><th>Account</th><th>Status</th><th className="r">Amount</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={`${c.id}-${c.sub_id}`} className={onEdit ? 'clickable txn-row' : undefined} onClick={onEdit ? () => onEdit(c) : undefined}>
              <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{(c.posted_date || c.txn_date) ? shortDate(c.posted_date || c.txn_date) : '—'}</td>
              <td className="muted" style={{ fontSize: 12 }}>{c.account_name || '—'}</td>
              <td>{c.posted_date
                ? <span className="muted" style={{ fontSize: 11 }}>Posted</span>
                : <span className="tag" style={{ color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>Pending</span>}</td>
              <td className="r money num">{money(c.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

export default function SubscriptionDetail() {
  const { subscriptionId } = useParams();
  const isNew = subscriptionId === 'new';
  const id = Number(subscriptionId);
  const navigate = useNavigate();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [paying, setPaying] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancelDate, setCancelDate] = useState(todayStr());
  const [err, setErr] = useState('');
  // Click-to-edit: full transactions behind the charges, plus the editor's
  // lookups + merchants (loaded lazily the first time a charges list is shown).
  const [txns, setTxns] = useState<Txn[]>([]);
  const [editingTxn, setEditingTxn] = useState<Txn | null>(null);
  const [editorLookups, setEditorLookups] = useState<Lookups | null>(null);
  const [merchants, setMerchants] = useState<string[]>([]);
  const [prices, setPrices] = useState<PricePoint[]>([]);
  // Exact total + count come from SQL (the displayed `charges` list is capped), so the
  // "Total Charges · N payments" figure is correct no matter how long the sub has run.
  const [chargeStats, setChargeStats] = useState<{ total: number; count: number }>({ total: 0, count: 0 });

  const loadSub = () => api.get<Subscription[]>('/subscriptions')
    .then((all) => { const s = all.find((x) => x.id === id) ?? null; setSub(s); if (!s) setErr('Subscription not found.'); })
    .catch((e) => setErr(e.message));
  const loadPrices = () => api.get<PricePoint[]>(`/subscriptions/${id}/price-history`).then(setPrices).catch(() => {});
  const loadCharges = () => api.get<{ charges: Charge[]; total: number; count: number }>(`/subscriptions/${id}/charges`)
    .then((r) => { setCharges(r.charges); setChargeStats({ total: r.total, count: r.count }); }).catch(() => {});
  // Full transaction objects for this subscription, so a charge row can open the
  // real transaction in the editor (matched by id). We page through every page so a
  // charge anywhere in the list can be opened, not just those on the first page.
  const loadTxns = async () => {
    try {
      const all: Txn[] = [];
      let pendingOffset = 0;
      let postedOffset = 0;
      for (;;) {
        const p = await api.get<TxnPage>(
          `/transactions?subscription_id=${id}&limit=${PAGE_SIZE}&pendingOffset=${pendingOffset}&postedOffset=${postedOffset}`,
        );
        all.push(...p.pending, ...p.posted);
        pendingOffset += p.pending.length;
        postedOffset += p.posted.length;
        if (pendingOffset >= p.pendingTotal && postedOffset >= p.total) break;
        if (p.pending.length === 0 && p.posted.length === 0) break; // safety: no progress
      }
      setTxns(all);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    api.get<Account[]>('/accounts').then(setAccounts).catch(() => {});
    if (isNew) return; // "new" mode renders an empty Add form; nothing to load
    if (!Number.isFinite(id)) { setErr('Invalid subscription.'); return; }
    loadSub(); loadCharges(); loadTxns(); loadPrices();
  }, [id]);

  // Lazily load the editor's lookups + merchants the first time the Charges tab
  // (the only clickable charge list) is opened.
  useEffect(() => {
    if (isNew || tab !== 'charges' || editorLookups) return;
    Promise.all([
      api.get<any[]>('/categories').catch(() => []),
      api.get<any[]>('/accounts').catch(() => []),
      api.get<any[]>('/vehicles').catch(() => []),
      api.get<any[]>('/properties').catch(() => []),
      api.get<any[]>('/subscriptions').catch(() => []),
      api.get<any[]>('/tags').catch(() => []),
    ]).then(([categories, accts, vehicles, properties, subscriptions, tags]) =>
      setEditorLookups({ categories, accounts: accts, vehicles, properties, subscriptions, tags: tags.filter((t: any) => !t.archived) } as Lookups));
    api.get<string[]>('/transactions/merchants').then(setMerchants).catch(() => {});
  }, [tab]);

  // A charge row maps to a real transaction (charge.id === transaction id) — open it.
  const editCharge = (c: Charge) => { const t = txns.find((x) => x.id === c.id); if (t) setEditingTxn(t); };
  const onEditCharge = editorLookups ? editCharge : undefined;

  // "Add subscription" — render the inline form on the page (no popup), mirroring vehicles/properties.
  if (isNew) {
    return (
      <>
        <BackLink to="/subscriptions" label="Back to Subscriptions" />
        <div className="page-head" style={{ marginTop: 10 }}>
          <div>
            <h1 className="title">Add Subscription</h1>
            <p className="subtitle">Track a recurring charge — streaming, software, memberships — and its true monthly cost.</p>
          </div>
        </div>
        <SubscriptionInfoForm sub={null} isNew accounts={accounts} onSaved={(ns) => ns && navigate(`/subscriptions/${ns.id}`)} />
      </>
    );
  }

  const logPayment = async () => {
    if (!confirm(`Log a ${money(sub!.amount)} payment for "${sub!.name}" today and roll the next renewal forward?`)) return;
    setPaying(true); setErr('');
    try {
      await api.post(`/subscriptions/${id}/pay`);
      loadSub(); loadCharges();
    } catch (e: any) { setErr(e.message); }
    finally { setPaying(false); }
  };

  // Status changes use dedicated endpoints (mirrors the vehicle/property dispose flow).
  const doCancel = async () => {
    setErr('');
    try { await api.post(`/subscriptions/${id}/cancel`, { date: cancelDate || todayStr() }); setCanceling(false); loadSub(); loadCharges(); } catch (e: any) { setErr(e.message); }
  };
  const doPause = async () => {
    setErr('');
    try { await api.post(`/subscriptions/${id}/pause`); loadSub(); } catch (e: any) { setErr(e.message); }
  };
  const doReactivate = async () => {
    setErr('');
    try { await api.post(`/subscriptions/${id}/reactivate`); loadSub(); loadCharges(); } catch (e: any) { setErr(e.message); }
  };

  if (err && !sub) {
    return (<><BackLink to="/subscriptions" label="Back to Subscriptions" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>);
  }
  if (!sub) return <Loading />;

  const s = sub;
  const subtitle = [serviceTypeLabel(s.service_type), cap(s.billing_cycle)].filter(Boolean).join(' · ');
  // Pending charges first (newest-first within each group), then posted.
  const byDateDesc = (a: Charge, b: Charge) => ((a.posted_date || a.txn_date || '') < (b.posted_date || b.txn_date || '') ? 1 : -1);
  const pendingCharges = charges.filter((c) => !c.posted_date).sort(byDateDesc);
  const postedCharges = charges.filter((c) => c.posted_date).sort(byDateDesc);
  const chargesByDate = [...pendingCharges, ...postedCharges];
  const total = chargeStats.total;
  const chargeCount = chargeStats.count;
  const memberSince = s.start_date || (postedCharges.length ? postedCharges[postedCharges.length - 1].txn_date : (chargesByDate.length ? chargesByDate[chargesByDate.length - 1].txn_date : null));

  // Only a real next charge if it renews before any scheduled cancellation.
  const nd = s.next_due_date, end = s.end_date;
  const renews = s.status !== 'canceled' && nd && (!end || nd.slice(0, 10) < end.slice(0, 10));

  const statusTag = s.status === 'active'
    ? <span className="tag">Active</span>
    : <span className="muted" style={{ fontSize: 13 }}>{cap(s.status)}</span>;

  const nextDueValue: ReactNode = renews
    ? <span className={dueClass(nd)}>{shortDate(nd!)} · {dueInLabel(nd)}</span>
    : (s.status === 'canceled' ? 'canceled' : end ? `cancels ${shortDate(end)}` : '—');

  // Overview facts — only push values that exist.
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Billing Cycle', value: cap(s.billing_cycle) },
    { label: 'Amount per Cycle', value: money(s.amount) },
    { label: 'Cost / Month', value: money(s.monthly_amount) },
    { label: 'Cost / Year', value: money(s.yearly_amount) },
    { label: 'Next Due', value: nextDueValue },
    { label: 'Member Since', value: memberSince ? shortDate(memberSince) : '—' },
    { label: 'Total Charges', value: `${money(total)} · ${chargeCount} payment${chargeCount === 1 ? '' : 's'}` },
  ];
  if (s.account_name) facts.push({ label: 'Account', value: s.account_name });
  if (normalizeUrl(s.website_url)) facts.push({ label: 'Website', value: <a href={normalizeUrl(s.website_url)!} target="_blank" rel="noreferrer">Visit ↗</a> });
  if (s.phone) facts.push({ label: 'Phone', value: <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`}>{formatPhone(s.phone)}</a> });
  if (s.login_id) facts.push({ label: 'Login ID', value: s.login_id });
  if (normalizeUrl(s.login_url)) facts.push({ label: 'Portal', value: <a href={normalizeUrl(s.login_url)!} target="_blank" rel="noreferrer">Log In ↗</a> });

  return (
    <>
      <BackLink to="/subscriptions" label="Back to Subscriptions" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {s.name}
            {s.tier && <span className="tag">{s.tier}</span>}
            {statusTag}
          </h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
          <div style={{ marginTop: 10 }}>
            <span className="num debit" style={{ fontSize: 26, fontWeight: 600 }}>{money(s.monthly_amount)}</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>/ month</span>
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Cost / Month</div><div className="value debit">{money(s.monthly_amount)}</div></div>
            <div className="card stat"><div className="label">Cost / Year</div><div className="value debit">{money(s.yearly_amount)}</div></div>
            <div className="card stat">
              <div className="label">Next Due</div>
              {renews
                ? <><div className="value small">{shortDate(nd!)}</div><div className={`muted ${dueClass(nd)}`} style={{ fontSize: 11 }}>{dueInLabel(nd)}</div></>
                : <><div className="value small">—</div><div className="muted" style={{ fontSize: 11 }}>{s.status === 'canceled' ? 'canceled' : end ? `cancels ${shortDate(end)}` : ''}</div></>}
            </div>
          </div>

          <div className="card">
            <div className="label" style={{ marginBottom: 10 }}>Summary</div>
            <FactList items={facts} />
          </div>

          {prices.length >= 2 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="label" style={{ marginBottom: 10 }}>Price History</div>
              <table className="ledger">
                <thead><tr><th>Effective</th><th>Cycle</th><th className="r">Amount</th><th className="r">Change</th></tr></thead>
                <tbody>
                  {prices.map((p, i) => {
                    const prev = prices[i + 1];
                    const delta = prev ? Number(p.amount) - Number(prev.amount) : 0;
                    return (
                      <tr key={p.id}>
                        <td className="num muted" style={{ fontSize: 12 }}>{shortDate(p.effective_date)}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{p.billing_cycle ? cap(p.billing_cycle) : '—'}</td>
                        <td className="r money num">{money(p.amount)}</td>
                        <td className={`r num ${delta > 0 ? 'debit' : delta < 0 ? 'credit' : 'muted'}`} style={{ fontSize: 12 }}>
                          {prev ? `${delta > 0 ? '+' : ''}${money(delta)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'documents' && <EntityDocuments basePath={`/subscriptions/${id}`} docTypes={SUBSCRIPTION_DOC_TYPES} />}

      {tab === 'charges' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>Charges appear here once a transaction is categorized to this subscription.</div>
            {s.status !== 'canceled' && (
              <button disabled={paying} onClick={logPayment} title="Record a payment and roll the renewal date forward">{paying ? 'Logging…' : 'Log Payment'}</button>
            )}
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 14 }}>
            <div className="card stat" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
              <div className="label">Member Since</div>
              <div className="value small">{memberSince ? shortDate(memberSince) : '—'}</div>
            </div>
            <div className="card stat" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
              <div className="label">Total Charges</div>
              <div className="value">{money(total)}</div>
              <div className="muted" style={{ fontSize: 11 }}>{chargeCount} payment{chargeCount === 1 ? '' : 's'}</div>
            </div>
            <div className="card stat" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
              <div className="label">Next Due</div>
              {renews
                ? <><div className="value small">{shortDate(nd!)}</div><div className={`muted ${dueClass(nd)}`} style={{ fontSize: 11 }}>{dueInLabel(nd)}</div></>
                : <><div className="value small">—</div><div className="muted" style={{ fontSize: 11 }}>{s.status === 'canceled' ? 'canceled' : end ? `cancels ${shortDate(end)}` : ''}</div></>}
            </div>
          </div>
          {pendingCharges.length > 0 && (
            <div style={{ marginBottom: postedCharges.length ? 18 : 0 }}>
              <div className="label" style={{ marginBottom: 8, color: 'var(--brass-deep)' }}>
                Pending · {pendingCharges.length} awaiting posting
              </div>
              <ChargeTable items={pendingCharges} onEdit={onEditCharge} />
            </div>
          )}
          {postedCharges.length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 8 }}>{pendingCharges.length > 0 ? 'Posted' : 'Charges'}</div>
              <ChargeTable items={postedCharges} onEdit={onEditCharge} />
            </>
          )}
          {charges.length === 0 && <ChargeTable items={[]} />}
        </>
      )}

      {tab === 'details' && (
        <>
          <SubscriptionInfoForm
            sub={s}
            accounts={accounts}
            onSaved={() => { loadSub(); loadCharges(); loadPrices(); }}
            onDeleted={() => navigate('/subscriptions')}
          />

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="section" style={{ margin: 0 }}>Manage Subscription</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {s.status === 'canceled'
                    ? `Canceled${end ? ` on ${shortDate(end)}` : ''} — kept for history, excluded from monthly totals.`
                    : s.status === 'paused'
                      ? 'Paused — excluded from monthly totals until you resume it. Its history is kept.'
                      : end
                        ? `Scheduled to cancel on ${shortDate(end)}. Reactivate to clear the cancellation.`
                        : 'Pause it to stop counting it temporarily, or cancel it to stop tracking renewals — its history is kept either way.'}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {s.status === 'canceled' ? (
                  <button className="ghost" onClick={doReactivate}>Reactivate Subscription</button>
                ) : (
                  <>
                    {s.status === 'paused'
                      ? <button className="ghost" onClick={doReactivate}>Resume</button>
                      : <button className="ghost" onClick={doPause}>Pause</button>}
                    {end
                      ? <button className="ghost" onClick={doReactivate}>Clear Cancellation</button>
                      : !canceling && <button className="ghost" onClick={() => { setCancelDate(todayStr()); setCanceling(true); }}>Cancel Subscription</button>}
                  </>
                )}
              </div>
            </div>
            {s.status !== 'canceled' && !end && canceling && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
                <div className="grid grid-2">
                  <Field label="Cancellation Date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} /></Field>
                </div>
                <div className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
                  {cancelDate && cancelDate > todayStr()
                    ? `Stays active until ${shortDate(cancelDate)}, then cancels and drops out of monthly totals.`
                    : 'Cancels immediately — it stops counting toward monthly totals but its history is kept.'}
                </div>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <button className="ghost" onClick={() => setCanceling(false)}>Cancel</button>
                  <button onClick={doCancel}>Mark as Canceled</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {editingTxn && editorLookups && (
        <TxnEditor
          txn={editingTxn}
          lookups={editorLookups}
          purchasers={[]}
          merchants={merchants}
          onClose={() => setEditingTxn(null)}
          onSaved={() => { setEditingTxn(null); loadCharges(); loadTxns(); loadSub(); }}
        />
      )}
    </>
  );
}

// Editable subscription info, rendered inline on the Details tab (no popup). A Save
// button enables once something changes. Mirrors the vehicle/property Details forms.
function SubscriptionInfoForm({ sub, isNew = false, accounts, onSaved, onDeleted }: {
  sub: Subscription | null; isNew?: boolean; accounts: Account[]; onSaved: (s?: Subscription) => void; onDeleted?: () => void;
}) {
  const seedOf = (s: Subscription | null) => ({
    name: s?.name ?? '',
    amount: s?.amount?.toString() ?? '',
    billing_cycle: s?.billing_cycle ?? 'monthly',
    next_due_date: s?.next_due_date?.slice(0, 10) ?? '',
    start_date: s?.start_date?.slice(0, 10) ?? '',
    account_id: s?.account_id?.toString() ?? '',
    tier: s?.tier ?? '',
    service_type: s?.service_type ?? '',
    login_url: s?.login_url ?? '',
    login_id: s?.login_id ?? '',
    website_url: s?.website_url ?? '',
    phone: s?.phone ?? '',
    notes: s?.notes ?? '',
  });

  const [f, setF] = useState(() => seedOf(sub));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seedOf(sub)));
  useEffect(() => { const s = seedOf(sub); setF(s); setSavedJson(JSON.stringify(s)); }, [sub?.id]);
  const dirty = JSON.stringify(f) !== savedJson;

  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  // An "Open" button next to a URL field — disabled until a real http(s) URL is entered.
  const OpenBtn = ({ value }: { value: string }) => (
    <button type="button" className="ghost" disabled={!isOpenableUrl(value)}
      onClick={() => { const u = normalizeUrl(value); if (u) window.open(u, '_blank', 'noopener'); }}
      style={{ whiteSpace: 'nowrap' }}>Open</button>
  );

  // Quick-fill from a known service (Add only).
  const [presetName, setPresetName] = useState('');
  const selectedPreset = SERVICE_PRESETS.find((s) => s.name === presetName) ?? null;
  const applyTier = (t: PresetTier) => setF((cur) => ({ ...cur, name: presetName, tier: t.tier, amount: String(t.amount), billing_cycle: t.cycle ?? 'monthly' }));

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    if (!f.amount || Number(f.amount) <= 0) { setErr('Amount must be greater than 0.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name,
      amount: Number(f.amount),
      billing_cycle: f.billing_cycle,
      next_due_date: f.next_due_date || null,
      start_date: f.start_date || null,
      account_id: f.account_id ? Number(f.account_id) : null,
      tier: f.tier.trim() || null,
      service_type: f.service_type || null,
      login_url: f.login_url.trim() || null,
      login_id: f.login_id.trim() || null,
      website_url: f.website_url.trim() || null,
      phone: f.phone.trim() || null,
      notes: f.notes || null,
    };
    try {
      const saved = isNew
        ? await api.post<Subscription>('/subscriptions', body)
        : await api.put<Subscription>(`/subscriptions/${sub!.id}`, body);
      setSavedJson(JSON.stringify(f));
      onSaved(saved);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!sub || !confirm(`Delete subscription "${sub.name}"?`)) return;
    try { await api.del(`/subscriptions/${sub.id}`); onDeleted?.(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>{isNew ? 'New Subscription' : 'Subscription Details'}</div>
        <div className="btn-row">
          {!isNew && onDeleted && <button className="danger" onClick={remove}>Delete</button>}
          <button onClick={save} disabled={(!dirty && !isNew) || saving}>{saving ? 'Saving…' : isNew ? 'Add Subscription' : 'Save Changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {isNew && (
        <div className="card" style={{ marginBottom: 16, background: 'var(--surface-alt)' }}>
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
              <select value="" disabled={!selectedPreset} onChange={(e) => { const t = selectedPreset?.tiers.find((x) => x.tier === e.target.value); if (t) applyTier(t); }}>
                <option value="">{selectedPreset ? 'Choose a plan…' : 'Pick a service first'}</option>
                {selectedPreset?.tiers.map((t) => <option key={t.tier} value={t.tier}>{t.tier} — {money(t.amount)}/{(t.cycle ?? 'monthly') === 'yearly' ? 'yr' : 'mo'}</option>)}
              </select>
            </Field>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Fills name, tier, price &amp; cycle below — prices are approximate; edit as needed.</div>
        </div>
      )}

      <div className="card">
        <Section title="Plan & Pricing" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-3">
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Netflix" /></Field>
            <Field label="Tier / Plan"><input value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} placeholder="e.g. Premium 4K, Family" /></Field>
            <Field label="Type">
              <select value={f.service_type} onChange={(e) => setF({ ...f, service_type: e.target.value })}>
                <option value="">—</option>
                {SERVICE_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Amount"><AmountInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} placeholder="0.00" /></Field>
            <Field label="Billing Cycle">
              <select value={f.billing_cycle} onChange={(e) => setF({ ...f, billing_cycle: e.target.value as Subscription['billing_cycle'] })}>
                {CYCLES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
              </select>
            </Field>
          </div>

          <EditorSection title="Notes" />
          <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="Billing & Account" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-3">
            <Field label="Account">
              <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
                <option value="">—</option>
                {accounts.filter((a) => isPayableFrom(a) || String(a.id) === f.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Started"><input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
            <Field label="Next Due Date"><input type="date" value={f.next_due_date} onChange={(e) => setF({ ...f, next_due_date: e.target.value })} /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Payments are filed automatically under the auto-managed “{f.name.trim() || 'Subscriptions'}” category — log them from the Charges tab or the transaction screen.
          </div>
        </Section>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <Section title="Account Access" headStyle={{ marginTop: 6, marginBottom: 6 }}>
          <div className="grid grid-2">
            <Field label="Web Address">
              <div className="row" style={{ gap: 8 }}>
                <input value={f.website_url} onChange={(e) => setF({ ...f, website_url: e.target.value })} placeholder="e.g. netflix.com" style={{ flex: 1 }} />
                <OpenBtn value={f.website_url} />
              </div>
            </Field>
            <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} onBlur={(e) => setF({ ...f, phone: formatPhone(e.target.value) })} placeholder="e.g. (800) 555-0100" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Login URL">
              <div className="row" style={{ gap: 8 }}>
                <input value={f.login_url} onChange={(e) => setF({ ...f, login_url: e.target.value })} placeholder="e.g. netflix.com/account" style={{ flex: 1 }} />
                <OpenBtn value={f.login_url} />
              </div>
            </Field>
            <Field label="Login ID"><input value={f.login_id} onChange={(e) => setF({ ...f, login_id: e.target.value })} placeholder="username or email" /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>The site, support line, and portal where you sign in to manage or cancel this subscription. Stored for quick access — don't keep your password here.</div>
        </Section>
      </div>
    </>
  );
}
