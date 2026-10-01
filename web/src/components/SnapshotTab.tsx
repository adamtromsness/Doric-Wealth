import { type ReactNode } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { money, shortDate } from '../api';
import { chartTooltip } from './ui';
import { SnapshotSection, type SnapItem } from './SnapshotSection';

// A snapshot-history tab shared by the vehicle Value and Odometer tabs and the
// property Value tab. Always the same two-card layout: an "… Over Time" area chart
// card (when there are ≥2 snapshots) followed by a list/add card — so switching
// between tabs keeps the chart the same size. Defaults render currency; pass
// `format`/`yTickFormat`/`integer` for other series (e.g. odometer miles). The
// per-asset estimate logic stays with the caller — pass `onEstimate` to expose it,
// and `estimateDisabledReason` to disable it with an explanation.
export function SnapshotTab({
  items, onAdd, onDelete,
  title = 'Value Snapshots', chartTitle = 'Value Over Time', valueLabel = 'Value', addLabel = 'Add Value',
  hint, emptyText,
  format = money, yTickFormat = (v: number) => '$' + Math.round(v / 1000) + 'k', integer = false, placeholder = '0.00', chartColor = '#6B7F6E',
  onEstimate, estimating = false, estimateMsg, estimateLabel = 'Estimate & Record', estimateDisabledReason,
  chartPoints,
}: {
  items: SnapItem[];
  onAdd: (as_of: string, value: number) => Promise<void> | void;
  onDelete: (id: number) => void;
  title?: string;
  chartTitle?: string;
  valueLabel?: string;
  addLabel?: string;
  hint?: ReactNode;
  emptyText?: ReactNode;
  format?: (n: number) => string;
  yTickFormat?: (n: number) => string;
  integer?: boolean;
  placeholder?: string;
  chartColor?: string;
  onEstimate?: () => void;
  estimating?: boolean;
  estimateMsg?: string;
  estimateLabel?: string;
  // When set, the estimate button is disabled and this explains why.
  estimateDisabledReason?: ReactNode;
  // Optional explicit chart series (e.g. seeded with a purchase price → today),
  // used for the chart only; the list/add row still come from `items`. Falls back
  // to deriving the series from `items` when omitted.
  chartPoints?: { as_of: string; value: number }[];
}) {
  const chartData = chartPoints && chartPoints.length
    ? chartPoints
    : [...items].sort((a, b) => (a.as_of < b.as_of ? -1 : 1)).map((s) => ({ as_of: s.as_of, value: Number(s.value) }));

  return (
    <>
      {chartData.length >= 2 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 8 }}>{chartTitle}</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="as_of" tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(d: string) => shortDate(d)} minTickGap={24} />
                <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => yTickFormat(v)} />
                <Tooltip contentStyle={chartTooltip} formatter={(v: number) => [format(Number(v)), valueLabel]} labelFormatter={(d) => shortDate(String(d))} />
                <Area type="monotone" dataKey="value" stroke={chartColor} fill={chartColor} fillOpacity={0.15} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
          <div>
            <div className="label" style={{ margin: 0 }}>{title}</div>
            {hint && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>}
          </div>
          {onEstimate && <button className="brass" onClick={onEstimate} disabled={estimating || !!estimateDisabledReason}>{estimating ? 'Estimating…' : estimateLabel}</button>}
        </div>
        {onEstimate && estimateDisabledReason && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{estimateDisabledReason}</div>}
        {estimateMsg && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{estimateMsg}</div>}
        {items.length === 0 && emptyText && <div className="banner" style={{ marginBottom: 12 }}>{emptyText}</div>}
        <SnapshotSection
          items={items} onAdd={onAdd} onDelete={onDelete}
          valueLabel={valueLabel} addLabel={addLabel}
          format={format} yTickFormat={yTickFormat} integer={integer} placeholder={placeholder}
          addAtTop hideChart
        />
      </div>
    </>
  );
}
