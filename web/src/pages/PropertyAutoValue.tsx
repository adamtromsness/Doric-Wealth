import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, shortDate } from '../api';
import type { Property } from './Properties';
import type { RentcastStatus } from './integrations/RentcastIntegration';

// On a property's Value tab: turn automatic RentCast value updates on or off, choose
// weekly or monthly, and see when it last updated (or why it couldn't).
export function PropertyAutoValue({ property, onChanged }: { property: Property; onChanged: () => void }) {
  const [rc, setRc] = useState<RentcastStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<RentcastStatus>('/integrations/rentcast').then(setRc).catch(() => {});
  }, []);

  const enabled = !!property.auto_value_enabled;
  const frequency = property.auto_value_frequency ?? 'monthly';
  const save = async (next: { enabled: boolean; frequency: string }) => {
    setErr(''); setSaving(true);
    try { await api.put(`/properties/${property.id}/auto-value`, next); onChanged(); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const noKey = rc != null && !rc.configured;
  const help = noKey && !enabled
    ? <>Records a RentCast estimate as a value snapshot each week or month. Add a RentCast API key under <Link to="/integrations/rentcast">Integrations → RentCast</Link> to turn this on.</>
    : enabled
      ? (property.auto_value_last_success_at
          ? `Last updated ${shortDate(property.auto_value_last_success_at)} from RentCast.`
          : 'The first automatic update runs within the next hour.')
      : 'Records a RentCast estimate as a value snapshot each week or month.';
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className={`check-card${enabled ? ' on' : ''}`} style={{ flex: 1, minWidth: 260, margin: 0, cursor: noKey && !enabled ? 'not-allowed' : 'pointer' }}>
          <input type="checkbox" checked={enabled} disabled={saving || (noKey && !enabled)}
            onChange={(e) => save({ enabled: e.target.checked, frequency })} />
          <span className="check-body">
            <span className="check-title">Update Value Automatically</span>
            <span className="check-help">{help}</span>
          </span>
        </label>
        {enabled && (
          <select aria-label="Update Frequency" value={frequency} disabled={saving}
            onChange={(e) => save({ enabled: true, frequency: e.target.value })} style={{ width: 'auto' }}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
          </select>
        )}
      </div>
      {enabled && property.auto_value_last_error && (
        <div className="error" style={{ marginTop: 8, marginBottom: 0 }}>Couldn't update automatically: {property.auto_value_last_error}</div>
      )}
      {err && <div className="error" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
    </div>
  );
}
