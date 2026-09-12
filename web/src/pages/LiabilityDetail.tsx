import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { BackLink, Field, AmountInput, EditorSection, Loading } from '../components/ui';
import { SnapshotTab } from '../components/SnapshotTab';
import { EntityDocuments } from '../components/EntityDocuments';

interface Liability {
  id: number;
  name: string;
  liability_type: string;
  balance: number | null;
  original_amount: number | null;
  interest_rate: number | null;
  notes: string | null;
  lender: string | null;
  account_number: string | null;
  due_day: number | null;
  minimum_payment: number | null;
  opened_date: string | null;
  payoff_date: string | null;
  tracks_balance: boolean;
  has_documents: boolean;
}
interface SnapItem { id: number; as_of: string; value: number }

const LIABILITY_TYPES: [string, string][] = [
  ['mortgage', 'Mortgage'], ['auto_loan', 'Auto Loan'], ['student_loan', 'Student Loan'],
  ['personal_loan', 'Personal Loan'], ['credit_card', 'Credit Card'], ['medical', 'Medical Debt'], ['other', 'Other'],
];
const typeLabel = (t: string) => LIABILITY_TYPES.find(([v]) => v === t)?.[1] ?? t;
const LIABILITY_DOC_TYPES: [string, string][] = [
  ['agreement', 'Loan Agreement'], ['statement', 'Statement'], ['payoff', 'Payoff Letter'],
  ['correspondence', 'Correspondence'], ['other', 'Other'],
];
const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

type Cap = 'balance' | 'documents';
type Tab = 'overview' | Cap | 'details';
const TABS: { key: Tab; label: string; cap?: Cap }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'balance', label: 'Balance', cap: 'balance' },
  { key: 'documents', label: 'Documents', cap: 'documents' },
  { key: 'details', label: 'Details' },
];
const capsOf = (l: Liability | null) => ({ balance: !!l?.tracks_balance, documents: !!l?.has_documents });

export default function LiabilityDetail() {
  const { liabilityId } = useParams();
  const id = Number(liabilityId);
  const navigate = useNavigate();
  const [liab, setLiab] = useState<Liability | null>(null);
  const [balances, setBalances] = useState<SnapItem[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [caps, setCaps] = useState(capsOf(null));
  const [err, setErr] = useState('');

  const load = () => api.get<Liability[]>('/liabilities')
    .then((all) => { const l = all.find((x) => x.id === id) ?? null; setLiab(l); setCaps(capsOf(l)); if (!l) setErr('Liability not found.'); })
    .catch((e) => setErr(e.message));
  const loadBalances = () => api.get<SnapItem[]>(`/liabilities/${id}/balances`).then((bs) => setBalances(bs.map((b) => ({ ...b, value: Number(b.value) })))).catch(() => {});
  useEffect(() => { if (!Number.isFinite(id)) { setErr('Invalid liability.'); return; } load(); loadBalances(); }, [id]);
  useEffect(() => { const t = TABS.find((x) => x.key === tab); if (t?.cap && !caps[t.cap]) setTab('details'); }, [caps, tab]);

  const addBalance = async (as_of: string, value: number) => { await api.post(`/liabilities/${id}/balances`, { as_of, value }); loadBalances(); load(); };
  const delBalance = async (bid: number) => { try { await api.del(`/liabilities/${id}/balances/${bid}`); loadBalances(); load(); } catch (e: any) { setErr(e.message); } };

  if (err && !liab) return <><BackLink to="/other-liabilities" label="Back to Other Liabilities" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>;
  if (!liab) return <Loading card backTo="/other-liabilities" backLabel="Back to Other Liabilities" />;
  const l = liab;

  const paidOff = l.original_amount != null && l.balance != null && l.original_amount > 0 ? (1 - l.balance / l.original_amount) : null;
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Type', value: typeLabel(l.liability_type) },
    { label: 'Balance Owed', value: <span className="debit">{l.balance != null ? money(l.balance) : '—'}</span> },
  ];
  if (l.original_amount != null) facts.push({ label: 'Original Amount', value: money(l.original_amount) });
  if (paidOff != null) facts.push({ label: 'Paid Off', value: `${Math.round(paidOff * 100)}%` });
  if (l.interest_rate != null) facts.push({ label: 'Interest Rate', value: `${l.interest_rate}%` });
  if (l.lender) facts.push({ label: 'Lender', value: l.lender });
  if (l.minimum_payment != null) facts.push({ label: 'Minimum Payment', value: money(l.minimum_payment) });
  if (l.due_day != null) facts.push({ label: 'Payment Due', value: ordinal(l.due_day) });
  if (l.payoff_date) facts.push({ label: 'Payoff Date', value: shortDate(l.payoff_date) });
  if (l.notes) facts.push({ label: 'Notes', value: l.notes });

  return (
    <>
      <BackLink to="/other-liabilities" label="Back to Other Liabilities" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {l.name}<span className="tag">{typeLabel(l.liability_type)}</span>
          </h1>
          <div style={{ marginTop: 10 }}>
            <span className="num debit" style={{ fontSize: 26, fontWeight: 600 }}>{l.balance != null ? money(l.balance) : '—'}</span>
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="tabs">
        {TABS.filter((t) => !t.cap || caps[t.cap]).map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Balance Owed</div><div className="value debit">{l.balance != null ? money(l.balance) : '—'}</div></div>
            <div className="card stat"><div className="label">Original Amount</div><div className="value small">{l.original_amount != null ? money(l.original_amount) : '—'}</div></div>
            <div className="card stat"><div className="label">Paid Off</div><div className="value small">{paidOff != null ? `${Math.round(paidOff * 100)}%` : '—'}</div></div>
          </div>
          <div className="card"><div className="label" style={{ marginBottom: 10 }}>Summary</div>
            <dl className="detail-list">{facts.map((f, i) => (<div key={i} className="detail-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>))}</dl>
          </div>
        </>
      )}

      {tab === 'balance' && (
        <SnapshotTab items={balances} onAdd={addBalance} onDelete={delBalance}
          title="Balance Snapshots" chartTitle="Balance Owed Over Time" valueLabel="Balance Owed" addLabel="Record Balance" chartColor="#A15648"
          hint="Record the balance owed on a date — the latest snapshot sets the current balance and tracks your paydown." />
      )}
      {tab === 'documents' && <EntityDocuments basePath={`/liabilities/${id}`} docTypes={LIABILITY_DOC_TYPES} />}

      {tab === 'details' && <LiabilityInfoForm liability={l} onCapsChange={setCaps} onSaved={() => { load(); loadBalances(); }} onDeleted={() => navigate('/other-liabilities')} />}
    </>
  );
}

function LiabilityInfoForm({ liability, onCapsChange, onSaved, onDeleted }: {
  liability: Liability; onCapsChange: (c: ReturnType<typeof capsOf>) => void; onSaved: () => void; onDeleted: () => void;
}) {
  const seedOf = (l: Liability) => ({
    name: l.name ?? '', liability_type: l.liability_type ?? 'other',
    balance: l.balance?.toString() ?? '', original_amount: l.original_amount?.toString() ?? '', interest_rate: l.interest_rate?.toString() ?? '',
    lender: l.lender ?? '', account_number: l.account_number ?? '', due_day: l.due_day?.toString() ?? '', minimum_payment: l.minimum_payment?.toString() ?? '',
    opened_date: l.opened_date?.slice(0, 10) ?? '', payoff_date: l.payoff_date?.slice(0, 10) ?? '', notes: l.notes ?? '',
    tracks_balance: !!l.tracks_balance, has_documents: !!l.has_documents,
  });
  const [f, setF] = useState(() => seedOf(liability));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seedOf(liability)));
  useEffect(() => { const s = seedOf(liability); setF(s); setSavedJson(JSON.stringify(s)); }, [liability.id]);
  useEffect(() => { onCapsChange({ balance: f.tracks_balance, documents: f.has_documents }); }, [f.tracks_balance, f.has_documents]);
  const dirty = JSON.stringify(f) !== savedJson;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const num = (s: string) => (s === '' ? null : Number(s));

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name, liability_type: f.liability_type,
      balance: f.tracks_balance ? undefined : num(f.balance), original_amount: num(f.original_amount), interest_rate: num(f.interest_rate),
      lender: f.lender || null, account_number: f.account_number || null, due_day: num(f.due_day), minimum_payment: num(f.minimum_payment),
      opened_date: f.opened_date || null, payoff_date: f.payoff_date || null, notes: f.notes || null,
      tracks_balance: f.tracks_balance, has_documents: f.has_documents,
    };
    try { await api.put(`/liabilities/${liability.id}`, body); setSavedJson(JSON.stringify(f)); onSaved(); }
    catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!confirm(`Delete "${liability.name}"? This can't be undone.`)) return;
    try { await api.del(`/liabilities/${liability.id}`); onDeleted(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>Liability Details</div>
        <div className="btn-row">
          <button className="danger" onClick={remove}>Delete</button>
          <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <div className="label" style={{ marginTop: 6, marginBottom: 6 }}>Summary</div>
        <div className="grid grid-2">
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Family loan" /></Field>
          <Field label="Type">
            <select value={f.liability_type} onChange={(e) => setF({ ...f, liability_type: e.target.value })}>
              {LIABILITY_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Lender / Servicer"><input value={f.lender} onChange={(e) => setF({ ...f, lender: e.target.value })} /></Field>
          <Field label="Account Number"><input value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} placeholder="Last 4 recommended" /></Field>
        </div>

        <EditorSection title="Balance & Rate" />
        <div className="grid grid-3">
          {!f.tracks_balance && <Field label="Current Balance"><AmountInput value={f.balance} onChange={(v) => setF({ ...f, balance: v })} placeholder="0.00" /></Field>}
          <Field label="Original Amount"><AmountInput value={f.original_amount} onChange={(v) => setF({ ...f, original_amount: v })} placeholder="0.00" /></Field>
          <Field label="Interest Rate (%)"><input className="num-input" inputMode="decimal" value={f.interest_rate} onChange={(e) => setF({ ...f, interest_rate: e.target.value })} placeholder="6.25" /></Field>
        </div>
        {f.tracks_balance && <div className="muted" style={{ fontSize: 12 }}>Current balance is set from the latest snapshot on the Balance tab.</div>}

        <EditorSection title="Payment & Terms" />
        <div className="grid grid-4">
          <Field label="Minimum Payment"><AmountInput value={f.minimum_payment} onChange={(v) => setF({ ...f, minimum_payment: v })} placeholder="0.00" /></Field>
          <Field label="Due Day (1–31)"><input className="num-input" inputMode="numeric" value={f.due_day} onChange={(e) => setF({ ...f, due_day: e.target.value })} placeholder="e.g. 15" /></Field>
          <Field label="Opened Date"><input type="date" value={f.opened_date} onChange={(e) => setF({ ...f, opened_date: e.target.value })} /></Field>
          <Field label="Payoff Date"><input type="date" value={f.payoff_date} onChange={(e) => setF({ ...f, payoff_date: e.target.value })} /></Field>
        </div>

        <EditorSection title="Notes" />
        <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="label" style={{ marginTop: 6, marginBottom: 6 }}>What This Liability Tracks</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Turn on the details this debt needs — each adds a dedicated tab.</div>
        <div className="grid grid-2">
          {([
            ['tracks_balance', 'Track balance over time', 'Dated balance snapshots + a paydown chart.'],
            ['has_documents', 'Track documents', 'Loan agreements, statements, payoff letters.'],
          ] as [keyof typeof f, string, string][]).map(([key, title, help]) => (
            <label key={key} className={`check-card${f[key] ? ' on' : ''}`}>
              <input type="checkbox" checked={!!f[key]} onChange={(e) => setF({ ...f, [key]: e.target.checked })} />
              <span className="check-body"><span className="check-title">{title}</span><span className="check-help">{help}</span></span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
