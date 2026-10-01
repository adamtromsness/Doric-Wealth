import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, shortDate } from '../api';

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
        <button className="head-add" onClick={() => navigate('/other-assets/new')}>Add Asset</button>
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
    </>
  );
}
