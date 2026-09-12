// Shared preset date-range filter used by the Transactions and Utilities pages.
export type RangeKey = 'all' | 'this_month' | 'last_month' | 'last_30' | 'last_90' | 'this_year' | 'last_year' | 'custom';

export const RANGES: [RangeKey, string][] = [
  ['all', 'All Time'], ['this_month', 'This Month'], ['last_month', 'Last Month'],
  ['last_30', 'Last 30 Days'], ['last_90', 'Last 90 Days'], ['this_year', 'This Year'],
  ['last_year', 'Last Year'], ['custom', 'Custom'],
];

// Resolve a preset (or custom) range into concrete from/to dates (YYYY-MM-DD).
// Relative presets recompute against today, so a saved "This month" stays current.
export function rangeDates(range: RangeKey, from = '', to = ''): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (range) {
    case 'this_month': return { from: fmt(new Date(y, m, 1)), to: fmt(new Date(y, m + 1, 0)) };
    case 'last_month': return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) };
    case 'last_30': { const d = new Date(now); d.setDate(d.getDate() - 30); return { from: fmt(d), to: '' }; }
    case 'last_90': { const d = new Date(now); d.setDate(d.getDate() - 90); return { from: fmt(d), to: '' }; }
    case 'this_year': return { from: fmt(new Date(y, 0, 1)), to: '' };
    case 'last_year': return { from: fmt(new Date(y - 1, 0, 1)), to: fmt(new Date(y - 1, 11, 31)) };
    case 'custom': return { from, to };
    default: return { from: '', to: '' };
  }
}
