import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { BackLink, Field, AmountInput, EditorSection, Loading } from '../components/ui';
import { SnapshotTab } from '../components/SnapshotTab';
import { EntityDocuments } from '../components/EntityDocuments';
import { EntityInsurance } from '../components/EntityInsurance';
import { EntityMaintenance } from '../components/EntityMaintenance';

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
interface SnapItem { id: number; as_of: string; value: number }

const ASSET_TYPES: [string, string][] = [
  ['rv', 'RV'], ['airplane', 'Airplane'], ['boat', 'Boat'],
  ['equipment', 'Equipment'], ['collectible', 'Collectible'], ['property', 'Property'], ['other', 'Other'],
];
const typeLabel = (t: string) => ASSET_TYPES.find(([v]) => v === t)?.[1] ?? t;
const ASSET_DOC_TYPES: [string, string][] = [
  ['title', 'Title / Registration'], ['bill_of_sale', 'Bill of Sale'], ['appraisal', 'Appraisal'],
  ['insurance', 'Insurance'], ['warranty', 'Warranty'], ['photo', 'Photo'], ['other', 'Other'],
];

type Cap = 'value' | 'maintenance' | 'insurance' | 'documents';
type Tab = 'overview' | Cap | 'details';
const TABS: { key: Tab; label: string; cap?: Cap }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'value', label: 'Value', cap: 'value' },
  { key: 'maintenance', label: 'Maintenance', cap: 'maintenance' },
  { key: 'insurance', label: 'Insurance', cap: 'insurance' },
  { key: 'documents', label: 'Documents', cap: 'documents' },
  { key: 'details', label: 'Details' },
];
const capsOf = (a: Asset | null) => ({
  value: !!a?.tracks_value, maintenance: !!a?.has_maintenance, insurance: !!a?.has_insurance, documents: !!a?.has_documents,
});

export default function AssetDetail() {
  const { assetId } = useParams();
  const id = Number(assetId);
  const navigate = useNavigate();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [values, setValues] = useState<SnapItem[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [caps, setCaps] = useState(capsOf(null));
  const [err, setErr] = useState('');

  const load = () => api.get<Asset[]>('/assets')
    .then((all) => { const a = all.find((x) => x.id === id) ?? null; setAsset(a); setCaps(capsOf(a)); if (!a) setErr('Asset not found.'); })
    .catch((e) => setErr(e.message));
  const loadValues = () => api.get<SnapItem[]>(`/assets/${id}/values`).then((vs) => setValues(vs.map((v) => ({ ...v, value: Number(v.value) })))).catch(() => {});
  useEffect(() => { if (!Number.isFinite(id)) { setErr('Invalid asset.'); return; } load(); loadValues(); }, [id]);
  // If the open tab's capability gets turned off, fall back to Details.
  useEffect(() => { const t = TABS.find((x) => x.key === tab); if (t?.cap && !caps[t.cap]) setTab('details'); }, [caps, tab]);

  const addValue = async (as_of: string, value: number) => { await api.post(`/assets/${id}/values`, { as_of, value }); loadValues(); load(); };
  const delValue = async (vid: number) => { try { await api.del(`/assets/${id}/values/${vid}`); loadValues(); load(); } catch (e: any) { setErr(e.message); } };

  if (err && !asset) return <><BackLink to="/other-assets" label="Back to Other Assets" /><div className="error" style={{ marginTop: 12 }}>{err}</div></>;
  if (!asset) return <Loading card backTo="/other-assets" backLabel="Back to Other Assets" />;
  const a = asset;

  const gain = a.value != null && a.purchase_price != null ? a.value - a.purchase_price : null;
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Type', value: typeLabel(a.asset_type) },
    { label: 'Current Value', value: a.value != null ? money(a.value) : '—' },
  ];
  if (a.purchase_price != null) facts.push({ label: 'Purchase Price', value: `${money(a.purchase_price)}${a.purchase_date ? ` · ${shortDate(a.purchase_date)}` : ''}` });
  if (gain != null) facts.push({ label: 'Gain / Loss', value: <span className={gain < 0 ? 'debit' : 'credit'}>{money(gain)}</span> });
  if (a.notes) facts.push({ label: 'Notes', value: a.notes });

  return (
    <>
      <BackLink to="/other-assets" label="Back to Other Assets" />
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {a.name}<span className="tag">{typeLabel(a.asset_type)}</span>
          </h1>
          <div style={{ marginTop: 10 }}>
            <span className="num" style={{ fontSize: 26, fontWeight: 600 }}>{a.value != null ? money(a.value) : '—'}</span>
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
            <div className="card stat"><div className="label">Current Value</div><div className="value">{a.value != null ? money(a.value) : '—'}</div></div>
            <div className="card stat"><div className="label">Purchase Price</div><div className="value small">{a.purchase_price != null ? money(a.purchase_price) : '—'}</div></div>
            <div className="card stat"><div className="label">Gain / Loss</div><div className={`value small ${gain != null && gain < 0 ? 'debit' : gain != null && gain > 0 ? 'credit' : ''}`}>{gain != null ? money(gain) : '—'}</div></div>
          </div>
          <div className="card"><div className="label" style={{ marginBottom: 10 }}>Summary</div>
            <dl className="detail-list">{facts.map((f, i) => (<div key={i} className="detail-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>))}</dl>
          </div>
        </>
      )}

      {tab === 'value' && (
        <SnapshotTab items={values} onAdd={addValue} onDelete={delValue}
          title="Value Snapshots" chartTitle="Value Over Time" valueLabel="Value" addLabel="Record Value"
          hint="Record the value on a date — the latest snapshot sets the asset's current value." />
      )}
      {tab === 'maintenance' && <EntityMaintenance basePath={`/assets/${id}`} />}
      {tab === 'insurance' && <EntityInsurance basePath={`/assets/${id}`} typeHint="e.g. Hull, Liability, Comprehensive" />}
      {tab === 'documents' && <EntityDocuments basePath={`/assets/${id}`} docTypes={ASSET_DOC_TYPES} />}

      {tab === 'details' && <AssetInfoForm asset={a} onCapsChange={setCaps} onSaved={() => { load(); loadValues(); }} onDeleted={() => navigate('/other-assets')} />}
    </>
  );
}

function AssetInfoForm({ asset, onCapsChange, onSaved, onDeleted }: {
  asset: Asset; onCapsChange: (c: ReturnType<typeof capsOf>) => void; onSaved: () => void; onDeleted: () => void;
}) {
  const seedOf = (a: Asset) => ({
    name: a.name ?? '', asset_type: a.asset_type ?? 'other',
    value: a.value?.toString() ?? '', purchase_price: a.purchase_price?.toString() ?? '',
    purchase_date: a.purchase_date?.slice(0, 10) ?? '', notes: a.notes ?? '',
    tracks_value: !!a.tracks_value, has_maintenance: !!a.has_maintenance, has_insurance: !!a.has_insurance, has_documents: !!a.has_documents,
  });
  const [f, setF] = useState(() => seedOf(asset));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(seedOf(asset)));
  useEffect(() => { const s = seedOf(asset); setF(s); setSavedJson(JSON.stringify(s)); }, [asset.id]);
  useEffect(() => { onCapsChange({ value: f.tracks_value, maintenance: f.has_maintenance, insurance: f.has_insurance, documents: f.has_documents }); },
    [f.tracks_value, f.has_maintenance, f.has_insurance, f.has_documents]);
  const dirty = JSON.stringify(f) !== savedJson;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const num = (s: string) => (s === '' ? null : Number(s));

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr('');
    const body = {
      name: f.name, asset_type: f.asset_type,
      value: f.tracks_value ? undefined : num(f.value), purchase_price: num(f.purchase_price),
      purchase_date: f.purchase_date || null, notes: f.notes || null,
      tracks_value: f.tracks_value, has_maintenance: f.has_maintenance, has_insurance: f.has_insurance, has_documents: f.has_documents,
    };
    try { await api.put(`/assets/${asset.id}`, body); setSavedJson(JSON.stringify(f)); onSaved(); }
    catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!confirm(`Delete "${asset.name}"? This can't be undone.`)) return;
    try { await api.del(`/assets/${asset.id}`); onDeleted(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="label" style={{ margin: 0 }}>Asset Details</div>
        <div className="btn-row">
          <button className="danger" onClick={remove}>Delete</button>
          <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <div className="label" style={{ marginTop: 6, marginBottom: 6 }}>Summary</div>
        <div className="grid grid-2">
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Airstream Trailer" /></Field>
          <Field label="Type">
            <select value={f.asset_type} onChange={(e) => setF({ ...f, asset_type: e.target.value })}>
              {ASSET_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-3">
          {!f.tracks_value && <Field label="Current Value"><AmountInput value={f.value} onChange={(v) => setF({ ...f, value: v })} placeholder="0.00" /></Field>}
          <Field label="Purchase Price"><AmountInput value={f.purchase_price} onChange={(v) => setF({ ...f, purchase_price: v })} placeholder="0.00" /></Field>
          <Field label="Purchase Date"><input type="date" value={f.purchase_date} onChange={(e) => setF({ ...f, purchase_date: e.target.value })} /></Field>
        </div>
        {f.tracks_value && <div className="muted" style={{ fontSize: 12 }}>Current value is set from the latest snapshot on the Value tab.</div>}

        <EditorSection title="Notes" />
        <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="label" style={{ marginTop: 6, marginBottom: 6 }}>What This Asset Tracks</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Turn on the details this asset needs — each adds a dedicated tab.</div>
        <div className="grid grid-2">
          {([
            ['tracks_value', 'Track value over time', 'Dated value snapshots + an over-time chart.'],
            ['has_maintenance', 'Track maintenance', 'Upcoming and completed service records.'],
            ['has_insurance', 'Track insurance', 'Policies, premiums, and renewal dates.'],
            ['has_documents', 'Track documents', 'Titles, bills of sale, appraisals, photos.'],
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
