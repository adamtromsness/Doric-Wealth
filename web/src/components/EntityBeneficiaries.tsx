import { useEffect, useState } from 'react';
import { api } from '../api';
import { Field } from './ui';

interface Beneficiary {
  id: number;
  name: string;
  relationship: string | null;
  kind: 'primary' | 'contingent';
  percentage: number | null;
  notes: string | null;
}

const blank = () => ({ name: '', relationship: '', kind: 'primary', percentage: '', notes: '' });
const seed = (b: Beneficiary) => ({
  name: b.name ?? '', relationship: b.relationship ?? '', kind: b.kind ?? 'primary',
  percentage: b.percentage?.toString() ?? '', notes: b.notes ?? '',
});

// Reusable structured-beneficiaries editor for the account Beneficiaries tab.
// `basePath` is the account REST base (e.g. "/accounts/5"); rows live at
// `${basePath}/beneficiaries`.
export function EntityBeneficiaries({ basePath }: { basePath: string }) {
  const [rows, setRows] = useState<Beneficiary[]>([]);
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState<number | 'new' | null>(null);
  const [f, setF] = useState(blank());

  const load = () => api.get<Beneficiary[]>(`${basePath}/beneficiaries`).then(setRows).catch(() => {});
  useEffect(() => { load(); }, [basePath]);

  const startAdd = () => { setF(blank()); setEditId('new'); };
  const startEdit = (b: Beneficiary) => { setF(seed(b)); setEditId(b.id); };

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setErr('');
    const body = { name: f.name.trim(), relationship: f.relationship || null, kind: f.kind, percentage: f.percentage, notes: f.notes || null };
    try {
      if (editId === 'new') await api.post(`${basePath}/beneficiaries`, body);
      else await api.put(`${basePath}/beneficiaries/${editId}`, body);
      setEditId(null); load();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (id: number) => {
    if (!confirm('Delete this beneficiary?')) return;
    try { await api.del(`${basePath}/beneficiaries/${id}`); if (editId === id) setEditId(null); load(); } catch (e: any) { setErr(e.message); }
  };

  const sumOf = (kind: string) => rows.filter((b) => b.kind === kind).reduce((s, b) => s + Number(b.percentage ?? 0), 0);
  const primaryPct = sumOf('primary');
  const group = (kind: 'primary' | 'contingent') => rows.filter((b) => b.kind === kind);

  const Table = ({ kind, title }: { kind: 'primary' | 'contingent'; title: string }) => {
    const list = group(kind);
    if (list.length === 0) return null;
    return (
      <div style={{ marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 8 }}>{title}</div>
        <div className="card" style={{ padding: 0 }}>
          <table className="ledger">
            <thead><tr><th>Name</th><th>Relationship</th><th className="r">Share</th><th></th></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}{b.notes ? <span className="muted" style={{ fontSize: 12 }}> · {b.notes}</span> : ''}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{b.relationship || '—'}</td>
                  <td className="r num">{b.percentage != null ? `${b.percentage}%` : '—'}</td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="ghost" style={{ padding: '2px 8px' }} title="Edit" onClick={() => startEdit(b)}>✎</button>
                    <button className="ghost" style={{ padding: '2px 8px', marginLeft: 4 }} title="Remove" onClick={() => del(b.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Who inherits this account. Primary beneficiaries should total 100%{primaryPct > 0 && primaryPct !== 100 ? ` — currently ${primaryPct}%` : ''}.
        </div>
        {editId === null && <button onClick={startAdd}>Add Beneficiary</button>}
      </div>

      {editId !== null && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="grid grid-2">
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Full name" /></Field>
            <Field label="Relationship"><input value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} placeholder="e.g. Spouse, Child" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Type">
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="primary">Primary</option>
                <option value="contingent">Contingent</option>
              </select>
            </Field>
            <Field label="Share (%)"><input className="num-input" inputMode="decimal" value={f.percentage} onChange={(e) => setF({ ...f, percentage: e.target.value })} placeholder="e.g. 50" /></Field>
          </div>
          <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button className="ghost" onClick={() => setEditId(null)}>Cancel</button>
            <button onClick={save}>{editId === 'new' ? 'Add Beneficiary' : 'Save Changes'}</button>
          </div>
        </div>
      )}

      {rows.length === 0 && editId === null ? (
        <div className="card"><div className="empty">No beneficiaries yet. Add the people who inherit this account.</div></div>
      ) : (
        <>
          <Table kind="primary" title="Primary" />
          <Table kind="contingent" title="Contingent" />
        </>
      )}
    </>
  );
}
