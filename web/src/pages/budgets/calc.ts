import type { RolloverMode, Section } from './types';

// "Jun 1 – Jun 30, 2026" (drops the repeated year when start/end share one).
export const fmtRange = (start: string, end: string): string => {
  const s = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
  const md = { month: 'short', day: 'numeric' } as const;
  const eStr = e.toLocaleDateString('en-US', { ...md, year: 'numeric' });
  const sStr = s.getFullYear() === e.getFullYear()
    ? s.toLocaleDateString('en-US', md)
    : s.toLocaleDateString('en-US', { ...md, year: 'numeric' });
  return `${sStr} – ${eStr}`;
};

export const behaviorText = (m: RolloverMode): string => (m === 'carryover' ? 'Carries over' : m === 'accrue' ? 'Accrues' : 'Resets each period');

// Monday (UTC) of the week containing a YYYY-MM-DD date — matches the server's weekly buckets.
export const mondayOf = (dateStr: string): string => {
  const x = new Date(dateStr + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};

export const isIncome = (s: Section): boolean => s.kind === 'income';
export const titleFor = (s: Section): string => (isIncome(s) ? 'Income' : 'Expenses');
export const actualLabel = (s: Section): string => (isIncome(s) ? 'Received' : 'Spent');
