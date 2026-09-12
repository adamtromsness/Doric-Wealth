import { useMemo, useState, type ReactNode } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { money, shortDate, todayStr } from '../api';
import { Modal, Field, chartTooltip, AmountInput } from './ui';

export interface SnapItem { id: number; as_of: string; value: number; auto?: boolean }

const PREVIEW = 10;

// Reusable history-of-a-value section: a value-over-time chart, a newest-first
// list (latest = "anchor") with delete + "View all", and an add row. Shared by
// account balance snapshots, property value snapshots, and vehicle odometer
// readings. Defaults render money; pass `format`/`yTickFormat`/`integer` for
// non-currency series (e.g. odometer miles).
export function SnapshotSection({ items, onAdd, onDelete, valueLabel = 'Value', addLabel = 'Add snapshot', hint,
  format = money, yTickFormat = (v: number) => '$' + Math.round(v / 1000) + 'k', integer = false, placeholder = '0.00', addAtTop = false, hideChart = false }: {
  items: SnapItem[];
  onAdd: (as_of: string, value: number) => Promise<void> | void;
  onDelete: (id: number) => void;
  valueLabel?: string;
  addLabel?: string;
  hint?: ReactNode;
  format?: (n: number) => string;
  yTickFormat?: (n: number) => string;
  integer?: boolean;
  placeholder?: string;
  addAtTop?: boolean;
  hideChart?: boolean;
}) {
  const [newSnap, setNewSnap] = useState({ as_of: todayStr(), value: '' });
  const [allOpen, setAllOpen] = useState(false);
  const [err, setErr] = useState('');

  const sorted = useMemo(() => [...items].sort((a, b) => (a.as_of < b.as_of ? 1 : -1)), [items]);
  const chartData = useMemo(
    () => [...items].sort((a, b) => (a.as_of < b.as_of ? -1 : 1)).map((s) => ({ as_of: s.as_of, value: Number(s.value) })),
    [items]
  );

  // Tolerant parse so "$1,200.50" is accepted, not read as NaN.
  const parsed0 = Number(String(newSnap.value).replace(/[,$\s]/g, ''));
  const parsed = integer ? Math.round(parsed0) : parsed0;
  const valid = newSnap.value.trim() !== '' && !Number.isNaN(parsed0);

  const add = async () => {
    if (!valid) return;
    setErr('');
    try {
      await onAdd(newSnap.as_of || todayStr(), parsed);
      setNewSnap({ as_of: todayStr(), value: '' });
    } catch (e: any) {
      // Keep the entered value so the user can correct it.
      setErr(e?.message || 'Could not save.');
    }
  };

  const row = (s: SnapItem, i: number) => (
    <tr key={s.id}>
      <td className="num">
        {shortDate(s.as_of)}
        {i === 0 && <span className="tag" style={{ marginLeft: 8 }}>latest</span>}
        {s.auto && <span className="tag" title="Recorded automatically from a SimpleFIN import" style={{ marginLeft: 6, color: 'var(--credit)', borderColor: 'var(--credit)' }}>⟳ auto</span>}
      </td>
      <td className="r money num">{format(Number(s.value))}</td>
      <td className="r"><button className="ghost" style={{ padding: '2px 8px' }} title="Delete" onClick={() => onDelete(s.id)}>✕</button></td>
    </tr>
  );

  const addBlock = (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="As of"><input type="date" value={newSnap.as_of} onChange={(e) => setNewSnap({ ...newSnap, as_of: e.target.value })} /></Field>
        <Field label={valueLabel}>
          {integer
            ? <input className="num-input" inputMode="numeric" value={newSnap.value} placeholder={placeholder} style={{ textAlign: 'right' }} onChange={(e) => setNewSnap({ ...newSnap, value: e.target.value })} />
            : <AmountInput value={newSnap.value} placeholder={placeholder} style={{ textAlign: 'right' }} onChange={(v) => setNewSnap({ ...newSnap, value: v })} />}
        </Field>
        <button style={{ marginBottom: 12 }} disabled={!valid} onClick={add}>{addLabel}</button>
      </div>
      {err && <div className="error" style={{ marginTop: -4, marginBottom: 8 }}>{err}</div>}
    </>
  );

  return (
    <>
      {hint && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{hint}</div>}

      {!hideChart && chartData.length >= 2 && (
        <div style={{ height: 150, marginBottom: 10 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="as_of" tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false}
                tickFormatter={(d: string) => shortDate(d)} minTickGap={24} />
              <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={56}
                tickFormatter={(v: number) => yTickFormat(v)} />
              <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [format(Number(v)), valueLabel]} labelFormatter={(d) => shortDate(String(d))} />
              <Area type="monotone" dataKey="value" stroke="#5A6F87" fill="#5A6F87" fillOpacity={0.15} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {addAtTop && addBlock}

      {sorted.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 8 }}>
          <table className="ledger">
            <thead><tr><th>As of</th><th className="r">{valueLabel}</th><th></th></tr></thead>
            <tbody>{sorted.slice(0, PREVIEW).map(row)}</tbody>
          </table>
          {sorted.length > PREVIEW && (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--hairline)' }}>
              <span className="muted" style={{ fontSize: 12 }}>Showing latest {PREVIEW} of {sorted.length}</span>
              <button className="ghost" style={{ padding: '2px 10px' }} onClick={() => setAllOpen(true)}>View all</button>
            </div>
          )}
        </div>
      )}

      {!addAtTop && addBlock}

      {allOpen && (
        <Modal title="History" onClose={() => setAllOpen(false)}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{sorted.length} entries, newest first.</div>
          <div className="card" style={{ padding: 0, maxHeight: '60vh', overflowY: 'auto' }}>
            <table className="ledger">
              <thead><tr><th>As of</th><th className="r">{valueLabel}</th><th></th></tr></thead>
              <tbody>{sorted.map(row)}</tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
