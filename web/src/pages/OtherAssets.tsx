import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { AmountInput, Field, Modal, EditorFooter, useDirty } from '../components/ui';

interface Asset {
  id: number;
  name: string;
  asset_type: string;
  value: number | null;
  purchase_price: number | null;
  purchase_date: string | null;
  notes: string | null;
  tracks_value: boolean;
  has_maintenance: boolean;
  has_insurance: boolean;
  has_documents: boolean;
}

const ASSET_TYPES: [string, string][] = [
  ['rv', 'RV'], ['airplane', 'Airplane'], ['boat', 'Boat'],
  ['equipment', 'Equipment'], ['collectible', 'Collectible'], ['other', 'Other'],
];
const typeLabel = (t: string) => ASSET_TYPES.find(([v]) => v === t)?.[1] ?? t;

export default function OtherAssets() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const load = () => api.get<Asset[]>('/assets').then(setAssets).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Assets</div>
          <h1 className="title">Other Assets</h1>
          <p className="subtitle">Things you own that don't fit a dedicated module — RVs, aircraft, boats, equipment, collectibles, and more. Open one to track its value, maintenance, insurance, and documents.</p>
        </div>
        <button className="head-add" onClick={() => setAdding(true)}>Add Asset</button>
      </div>

      {err && <div className="error">{err}</div>}

      {assets.length === 0 ? (
        <div className="card"><div className="empty">No other assets yet. Add one to start tracking.</div></div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {assets.map((a) => {
            const gain = a.value != null && a.purchase_price != null ? a.value - a.purchase_price : null;
            const tracks: string[] = [];
            if (a.tracks_value) tracks.push('Value');
            if (a.has_maintenance) tracks.push('Maintenance');
            if (a.has_insurance) tracks.push('Insurance');
            if (a.has_documents) tracks.push('Documents');
            return (
              <div key={a.id} className="card kindcard income clickable" style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/other-assets/${a.id}`)} title="View asset details">
                <div className="kindcard-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {a.name}
                      <span className="tag">{typeLabel(a.asset_type)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {a.notes ? a.notes : (a.purchase_date ? `Purchased ${shortDate(a.purchase_date)}` : 'Asset')}
                    </div>
                  </div>
                  <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/other-assets/${a.id}`); }}>View Details →</button>
                </div>

                <div style={{ padding: '12px 14px' }}>
                  <div className="grid grid-3" style={{ marginBottom: tracks.length ? 8 : 0 }}>
                    <div className="stat"><div className="label">Value</div><div className="value small">{a.value != null ? money(a.value) : '—'}</div></div>
                    <div className="stat"><div className="label">Purchase Price</div><div className="value small">{a.purchase_price != null ? money(a.purchase_price) : '—'}</div></div>
                    <div className="stat"><div className="label">Gain / Loss</div><div className={`value small ${gain != null && gain < 0 ? 'debit' : gain != null && gain > 0 ? 'credit' : ''}`}>{gain != null ? money(gain) : '—'}</div></div>
                  </div>
                  {tracks.length > 0 && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <span className="muted" style={{ fontSize: 11 }}>Tracks:</span>
                      {tracks.map((t) => <span key={t} className="tag" style={{ fontSize: 11, textTransform: 'none' }}>{t}</span>)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding && <AssetEditor onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); load(); if (id) navigate(`/other-assets/${id}`); }} />}
    </>
  );
}

function AssetEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (id?: number) => void }) {
  const [f, setF] = useState({ name: '', asset_type: 'other', value: '', purchase_price: '', purchase_date: '', notes: '' });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = useDirty(f);
  const num = (s: string) => (s === '' ? null : Number(s));

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name, asset_type: f.asset_type, value: num(f.value),
      purchase_price: num(f.purchase_price), purchase_date: f.purchase_date || null, notes: f.notes || null,
    };
    try {
      const a = await api.post<{ id: number }>('/assets', body);
      onSaved(a.id);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <Modal title={`Add ${typeLabel(f.asset_type).toLowerCase()}`} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="grid grid-2">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Lake cabin boat" /></Field>
        <Field label="Type">
          <select value={f.asset_type} onChange={(e) => setF({ ...f, asset_type: e.target.value })}>
            {ASSET_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Current Value"><AmountInput value={f.value} onChange={(v) => setF({ ...f, value: v })} placeholder="0.00" /></Field>
      <div className="grid grid-2">
        <Field label="Purchase Price"><AmountInput value={f.purchase_price} onChange={(v) => setF({ ...f, purchase_price: v })} /></Field>
        <Field label="Purchase Date"><input type="date" value={f.purchase_date} onChange={(e) => setF({ ...f, purchase_date: e.target.value })} /></Field>
      </div>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <EditorFooter onClose={onClose} onSave={save} saveLabel="Add Asset" saving={saving} disabled={!dirty} />
    </Modal>
  );
}
