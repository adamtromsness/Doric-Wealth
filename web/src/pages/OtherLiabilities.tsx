import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { AmountInput, Field, Modal, EditorFooter, useDirty } from '../components/ui';

interface Liability {
  id: number;
  name: string;
  liability_type: string;
  balance: number | null;
  original_amount: number | null;
  interest_rate: number | null;
  notes: string | null;
}

const LIABILITY_TYPES: [string, string][] = [
  ['mortgage', 'Mortgage'], ['auto_loan', 'Auto Loan'], ['student_loan', 'Student Loan'],
  ['personal_loan', 'Personal Loan'], ['credit_card', 'Credit Card'], ['medical', 'Medical Debt'], ['other', 'Other'],
];
const typeLabel = (t: string) => LIABILITY_TYPES.find(([v]) => v === t)?.[1] ?? t;

export default function OtherLiabilities() {
  const [items, setItems] = useState<Liability[]>([]);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const load = () => api.get<Liability[]>('/liabilities').then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const saved = () => { setAdding(false); load(); };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Liabilities</div>
          <h1 className="title">Other Liabilities</h1>
          <p className="subtitle">Standalone debts not tracked as an account — personal loans, medical debt, and the like. Credit cards and loans with balance history belong on Liability Accounts.</p>
        </div>
        <button className="head-add" onClick={() => setAdding(true)}>Add Liability</button>
      </div>

      {err && <div className="error">{err}</div>}

      {items.length === 0 ? (
        <div className="card"><div className="empty">No standalone liabilities yet. Add one to start tracking.</div></div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {items.map((l) => (
            <div key={l.id} className="card kindcard expense clickable" style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/other-liabilities/${l.id}`)} title="View liability details">
              <div className="kindcard-head">
                <div style={{ minWidth: 0 }}>
                  <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {l.name}
                    <span className="tag">{typeLabel(l.liability_type)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{l.notes || 'Standalone debt'}</div>
                </div>
                <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/other-liabilities/${l.id}`); }}>View Details →</button>
              </div>
              <div style={{ padding: '12px 14px' }}>
                <div className="grid grid-3">
                  <div className="stat"><div className="label">Balance Owed</div><div className="value small debit">{money(l.balance)}</div></div>
                  <div className="stat"><div className="label">Interest Rate</div><div className="value small">{l.interest_rate != null ? `${l.interest_rate}%` : '—'}</div></div>
                  <div className="stat"><div className="label">Original</div><div className="value small">{l.original_amount != null ? money(l.original_amount) : '—'}</div></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <LiabilityEditor liability={null} onClose={() => setAdding(false)} onSaved={(nid) => { setAdding(false); load(); if (nid) navigate(`/other-liabilities/${nid}`); }} />
      )}
    </>
  );
}

function LiabilityEditor({ onClose, onSaved }: { liability: Liability | null; onClose: () => void; onSaved: (id?: number) => void }) {
  const [f, setF] = useState({
    name: '', liability_type: 'personal_loan', balance: '', original_amount: '', interest_rate: '', notes: '',
  });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = useDirty(f);
  const num = (s: string) => (s === '' ? null : Number(s));

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name, liability_type: f.liability_type, balance: num(f.balance),
      original_amount: num(f.original_amount), interest_rate: num(f.interest_rate), notes: f.notes || null,
    };
    try {
      const r = await api.post<{ id: number }>('/liabilities', body);
      onSaved(r.id);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <Modal title={`Add ${typeLabel(f.liability_type).toLowerCase()}`} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="grid grid-2">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Family loan" /></Field>
        <Field label="Type">
          <select value={f.liability_type} onChange={(e) => setF({ ...f, liability_type: e.target.value })}>
            {LIABILITY_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Current Balance"><AmountInput value={f.balance} onChange={(v) => setF({ ...f, balance: v })} placeholder="0.00" /></Field>
      <div className="grid grid-2">
        <Field label="Original Amount"><AmountInput value={f.original_amount} onChange={(v) => setF({ ...f, original_amount: v })} /></Field>
        <Field label="Interest Rate (%)"><input className="num-input" inputMode="decimal" value={f.interest_rate} onChange={(e) => setF({ ...f, interest_rate: e.target.value })} placeholder="6.25" /></Field>
      </div>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <EditorFooter onClose={onClose} onSave={save} saveLabel="Add Liability" saving={saving} disabled={!dirty} />
    </Modal>
  );
}
