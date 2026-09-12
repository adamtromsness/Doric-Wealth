import { useEffect, useState } from 'react';
import { api, money, shortDate } from '../api';
import { Field, AmountInput } from './ui';

interface MaintItem {
  id: number;
  item: string;
  status: 'completed' | 'upcoming';
  service_date: string | null;
  cost: number | null;
  due_date: string | null;
  vendor: string | null;
  notes: string | null;
}

const blank = () => ({ item: '', status: 'completed', service_date: '', due_date: '', vendor: '', cost: '', notes: '' });
const seed = (m: MaintItem) => ({
  item: m.item ?? '', status: m.status ?? 'completed', service_date: m.service_date ?? '',
  due_date: m.due_date ?? '', vendor: m.vendor ?? '', cost: m.cost?.toString() ?? '', notes: m.notes ?? '',
});

// Reusable maintenance / service-log editor (completed history + upcoming items),
// used by the asset detail page. `basePath` is the entity REST base (e.g.
// "/assets/5"); rows live at `${basePath}/maintenance`.
export function EntityMaintenance({ basePath }: { basePath: string }) {
  const [rows, setRows] = useState<MaintItem[]>([]);
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState<number | 'new' | null>(null);
  const [f, setF] = useState(blank());

  const load = () => api.get<MaintItem[]>(`${basePath}/maintenance`).then(setRows).catch(() => {});
  useEffect(() => { load(); }, [basePath]);

  const startAdd = (status: 'completed' | 'upcoming') => { setF({ ...blank(), status }); setEditId('new'); };
  const startEdit = (m: MaintItem) => { setF(seed(m)); setEditId(m.id); };

  const save = async () => {
    if (!f.item.trim()) { setErr('Item is required.'); return; }
    setErr('');
    const body = { item: f.item.trim(), status: f.status, service_date: f.service_date || null, due_date: f.due_date || null, vendor: f.vendor || null, cost: f.cost, notes: f.notes || null };
    try {
      if (editId === 'new') await api.post(`${basePath}/maintenance`, body);
      else await api.put(`${basePath}/maintenance/${editId}`, body);
      setEditId(null); load();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (id: number) => {
    if (!confirm('Delete this maintenance item?')) return;
    try { await api.del(`${basePath}/maintenance/${id}`); if (editId === id) setEditId(null); load(); } catch (e: any) { setErr(e.message); }
  };

  const upcoming = rows.filter((m) => m.status === 'upcoming');
  const completed = rows.filter((m) => m.status === 'completed');

  const Editor = () => (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="grid grid-2">
        <Field label="Item"><input value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="e.g. Annual service, engine overhaul" /></Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="completed">Completed</option>
            <option value="upcoming">Upcoming</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-3">
        {f.status === 'completed'
          ? <Field label="Service Date"><input type="date" value={f.service_date} onChange={(e) => setF({ ...f, service_date: e.target.value })} /></Field>
          : <Field label="Due Date"><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>}
        <Field label="Vendor"><input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></Field>
        <Field label="Cost"><AmountInput value={f.cost} onChange={(v) => setF({ ...f, cost: v })} placeholder="0.00" /></Field>
      </div>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button className="ghost" onClick={() => setEditId(null)}>Cancel</button>
        <button onClick={save}>{editId === 'new' ? 'Add Item' : 'Save Changes'}</button>
      </div>
    </div>
  );

  const Table = ({ list, dateLabel, dateOf }: { list: MaintItem[]; dateLabel: string; dateOf: (m: MaintItem) => string | null }) => (
    <div className="card" style={{ padding: 0 }}>
      <table className="ledger">
        <thead><tr><th>Item</th><th>{dateLabel}</th><th>Vendor</th><th className="r">Cost</th><th></th></tr></thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id}>
              <td>{m.item}{m.notes ? <span className="muted" style={{ fontSize: 12 }}> · {m.notes}</span> : ''}</td>
              <td className="num muted" style={{ fontSize: 12 }}>{dateOf(m) ? shortDate(dateOf(m)!) : '—'}</td>
              <td className="muted" style={{ fontSize: 12 }}>{m.vendor || '—'}</td>
              <td className="r num">{m.cost != null ? money(m.cost) : '—'}</td>
              <td className="r" style={{ whiteSpace: 'nowrap' }}>
                <button className="ghost" style={{ padding: '2px 8px' }} title="Edit" onClick={() => startEdit(m)}>✎</button>
                <button className="ghost" style={{ padding: '2px 8px', marginLeft: 4 }} title="Delete" onClick={() => del(m.id)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {editId !== null && <Editor />}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '0 0 8px' }}>
        <div className="label" style={{ margin: 0 }}>Upcoming</div>
        {editId === null && <button className="ghost" onClick={() => startAdd('upcoming')}>Add Upcoming</button>}
      </div>
      {upcoming.length > 0 ? <Table list={upcoming} dateLabel="Due" dateOf={(m) => m.due_date} /> : <div className="card"><div className="empty">No upcoming maintenance scheduled.</div></div>}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', margin: '18px 0 8px' }}>
        <div className="label" style={{ margin: 0 }}>Service History</div>
        {editId === null && <button className="ghost" onClick={() => startAdd('completed')}>Add Completed</button>}
      </div>
      {completed.length > 0 ? <Table list={completed} dateLabel="Date" dateOf={(m) => m.service_date} /> : <div className="card"><div className="empty">No service history yet.</div></div>}
    </>
  );
}
