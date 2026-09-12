import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rangeDates, RANGES } from './dateRange';

describe('rangeDates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed "today" = 2026-03-15 (a Sunday), local time.
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('this_month spans the first to last day of the current month', () => {
    expect(rangeDates('this_month')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });
  it('last_month spans the previous month', () => {
    expect(rangeDates('last_month')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
  it('last_30 / last_90 set an open-ended from', () => {
    expect(rangeDates('last_30')).toEqual({ from: '2026-02-13', to: '' });
    expect(rangeDates('last_90')).toEqual({ from: '2025-12-15', to: '' });
  });
  it('this_year starts Jan 1', () => {
    expect(rangeDates('this_year')).toEqual({ from: '2026-01-01', to: '' });
  });
  it('last_year spans the whole prior year', () => {
    expect(rangeDates('last_year')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
  it('custom passes through the provided from/to', () => {
    expect(rangeDates('custom', '2026-01-10', '2026-01-20')).toEqual({ from: '2026-01-10', to: '2026-01-20' });
  });
  it('all (default) returns empty bounds', () => {
    expect(rangeDates('all')).toEqual({ from: '', to: '' });
  });
  it('exposes the full preset list', () => {
    expect(RANGES.map(([k]) => k)).toContain('this_month');
  });
});
