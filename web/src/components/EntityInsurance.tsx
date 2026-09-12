import { useEffect, useState } from 'react';
import { api, money, shortDate, formatPhone } from '../api';
import { Field, AmountInput } from './ui';

export interface InsurancePolicy {
  id: number;
  policy_type: string | null;
  carrier: string | null;
  policy_number: string | null;
  premium: number | null;
  premium_cycle: 'monthly' | 'quarterly' | 'semiannual' | 'annual';
  coverage: string | null;
  deductible: number | null;
  agent_name: string | null;
  agent_phone: string | null;
  start_date: string | null;
  renewal_date: string | null;
  notes: string | null;
}

const CYCLES: [string, string][] = [
  ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['semiannual', 'Semi-Annual'], ['annual', 'Annual'],
];
const cycleLabel = (c: string) => CYCLES.find(([v]) => v === c)?.[1] ?? c;
const blank = () => ({
  policy_type: '', carrier: '', policy_number: '', premium: '', premium_cycle: 'monthly',
  coverage: '', deductible: '', agent_name: '', agent_phone: '', start_date: '', renewal_date: '', notes: '',
});
const seed = (p: InsurancePolicy) => ({
  policy_type: p.policy_type ?? '', carrier: p.carrier ?? '', policy_number: p.policy_number ?? '',
  premium: p.premium?.toString() ?? '', premium_cycle: p.premium_cycle ?? 'monthly',
  coverage: p.coverage ?? '', deductible: p.deductible?.toString() ?? '',
  agent_name: p.agent_name ?? '', agent_phone: p.agent_phone ?? '',
  start_date: p.start_date ?? '', renewal_date: p.renewal_date ?? '', notes: p.notes ?? '',
});

// Days from today to an ISO date (negative = past).
const daysUntil = (iso: string | null) => {
  if (!iso) return null;
  const ms = new Date(iso + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime();
  return Math.round(ms / 86400000);
};

// Reusable insurance-policy manager used by the vehicle & property detail pages.
// `basePath` is the owning entity's REST base (e.g. "/vehicles/5"); policies live
// at `${basePath}/insurance`.
export function EntityInsurance({ basePath, typeHint = 'e.g. Auto, Comprehensive' }: { basePath: string; typeHint?: string }) {
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState<number | 'new' | null>(null);
  const [f, setF] = useState(blank());

  const load = () => api.get<InsurancePolicy[]>(`${basePath}/insurance`).then(setPolicies).catch(() => {});
  useEffect(() => { load(); }, [basePath]);

  const startAdd = () => { setF(blank()); setEditId('new'); };
  const startEdit = (p: InsurancePolicy) => { setF(seed(p)); setEditId(p.id); };
  const cancel = () => setEditId(null);

  const save = async () => {
    setErr('');
    const body = {
      policy_type: f.policy_type, carrier: f.carrier, policy_number: f.policy_number,
      premium: f.premium, premium_cycle: f.premium_cycle, coverage: f.coverage, deductible: f.deductible,
      agent_name: f.agent_name, agent_phone: f.agent_phone,
      start_date: f.start_date || null, renewal_date: f.renewal_date || null, notes: f.notes,
    };
    try {
      if (editId === 'new') await api.post(`${basePath}/insurance`, body);
      else await api.put(`${basePath}/insurance/${editId}`, body);
      setEditId(null); load();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (id: number) => {
    if (!confirm('Delete this insurance policy?')) return;
    try { await api.del(`${basePath}/insurance/${id}`); if (editId === id) setEditId(null); load(); } catch (e: any) { setErr(e.message); }
  };

  const renewalTag = (iso: string | null) => {
    const d = daysUntil(iso);
    if (d == null) return null;
    if (d < 0) return <span className="tag" style={{ color: 'var(--debit)', borderColor: 'var(--debit)' }}>expired</span>;
    if (d <= 30) return <span className="tag" style={{ color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>in {d}d</span>;
    return null;
  };

  return (
    <>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12 }}>Policies, premiums, and renewal dates — kept for reference and reminders.</div>
        {editId === null && <button onClick={startAdd}>Add Policy</button>}
      </div>

      {editId !== null && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="grid grid-3">
            <Field label="Type"><input value={f.policy_type} onChange={(e) => setF({ ...f, policy_type: e.target.value })} placeholder={typeHint} /></Field>
            <Field label="Carrier"><input value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} placeholder="e.g. State Farm" /></Field>
            <Field label="Policy Number"><input value={f.policy_number} onChange={(e) => setF({ ...f, policy_number: e.target.value })} /></Field>
          </div>
          <div className="grid grid-3">
            <Field label="Premium"><AmountInput value={f.premium} onChange={(v) => setF({ ...f, premium: v })} placeholder="0.00" /></Field>
            <Field label="Premium Cycle">
              <select value={f.premium_cycle} onChange={(e) => setF({ ...f, premium_cycle: e.target.value })}>
                {CYCLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </Field>
            <Field label="Deductible"><AmountInput value={f.deductible} onChange={(v) => setF({ ...f, deductible: v })} placeholder="0.00" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Start Date"><input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
            <Field label="Renewal Date"><input type="date" value={f.renewal_date} onChange={(e) => setF({ ...f, renewal_date: e.target.value })} /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Agent / Contact"><input value={f.agent_name} onChange={(e) => setF({ ...f, agent_name: e.target.value })} /></Field>
            <Field label="Agent Phone"><input value={f.agent_phone} onChange={(e) => setF({ ...f, agent_phone: e.target.value })} onBlur={(e) => setF({ ...f, agent_phone: formatPhone(e.target.value) })} placeholder="e.g. (800) 555-0100" /></Field>
          </div>
          <Field label="Coverage"><input value={f.coverage} onChange={(e) => setF({ ...f, coverage: e.target.value })} placeholder="e.g. 100/300/100, $250k dwelling" /></Field>
          <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button className="ghost" onClick={cancel}>Cancel</button>
            <button onClick={save}>{editId === 'new' ? 'Add Policy' : 'Save Changes'}</button>
          </div>
        </div>
      )}

      {policies.length === 0 ? (
        editId === null && <div className="card"><div className="empty">No insurance policies yet. Add one to track premiums and renewals.</div></div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="ledger">
            <thead><tr><th>Type / Carrier</th><th>Policy #</th><th className="r">Premium</th><th className="r">Renews</th><th></th></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.policy_type || 'Policy'}{p.carrier ? <span className="muted"> · {p.carrier}</span> : ''}</div>
                    {p.agent_phone && <div className="muted" style={{ fontSize: 12 }}><a href={`tel:${p.agent_phone.replace(/[^\d+]/g, '')}`}>{formatPhone(p.agent_phone)}</a>{p.agent_name ? ` · ${p.agent_name}` : ''}</div>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{p.policy_number || '—'}</td>
                  <td className="r num">{p.premium != null ? <>{money(p.premium)}<span className="muted" style={{ fontSize: 11 }}> / {cycleLabel(p.premium_cycle)}</span></> : '—'}</td>
                  <td className="r num" style={{ fontSize: 12 }}>{p.renewal_date ? <>{shortDate(p.renewal_date)} {renewalTag(p.renewal_date)}</> : '—'}</td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="ghost" style={{ padding: '2px 8px' }} title="Edit" onClick={() => startEdit(p)}>✎</button>
                    <button className="ghost" style={{ padding: '2px 8px', marginLeft: 4 }} title="Delete" onClick={() => del(p.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
