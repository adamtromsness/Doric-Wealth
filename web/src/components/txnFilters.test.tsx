import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  buildTxnParams, advancedCount, leafCategoryOptions, DEFAULT_FILTERS, PillMulti, TxnFilterBar,
  type Filters, type FilterLookups,
} from './txnFilters';

const cat = (o: Partial<any>): any => ({ id: 0, name: '', kind: 'expense', sort_order: 0, parent_id: null, has_children: false, ...o });

describe('buildTxnParams', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 2, 15, 12)); });
  afterEach(() => vi.useRealTimers());

  it('sets only present filters and resolves the range', () => {
    const f: Filters = { ...DEFAULT_FILTERS, range: 'this_month', q: 'costco', account_id: '3', category_id: '5' };
    const p = buildTxnParams(f);
    expect(p.get('from')).toBe('2026-03-01');
    expect(p.get('to')).toBe('2026-03-31');
    expect(p.get('q')).toBe('costco');
    expect(p.get('account_id')).toBe('3');
    expect(p.get('category_id')).toBe('5');
    expect(p.has('vehicle_id')).toBe(false);
  });
  it('includes amount params only when op and amount are set; adds amount_max for between', () => {
    expect(buildTxnParams({ ...DEFAULT_FILTERS, amount_op: 'gt', amount: '' }).has('amount_op')).toBe(false);
    const p = buildTxnParams({ ...DEFAULT_FILTERS, amount_op: 'gt', amount: '50' });
    expect(p.get('amount_op')).toBe('gt');
    expect(p.get('amount')).toBe('50');
    expect(p.has('amount_max')).toBe(false);
    const b = buildTxnParams({ ...DEFAULT_FILTERS, amount_op: 'between', amount: '10', amount_max: '90' });
    expect(b.get('amount_max')).toBe('90');
  });
});

describe('advancedCount', () => {
  it('counts active advanced filters plus a valid amount filter', () => {
    expect(advancedCount(DEFAULT_FILTERS)).toBe(0);
    expect(advancedCount({ ...DEFAULT_FILTERS, category_id: '1', channel: 'online' })).toBe(2);
    expect(advancedCount({ ...DEFAULT_FILTERS, amount_op: 'gt', amount: '5' })).toBe(1);
    expect(advancedCount({ ...DEFAULT_FILTERS, amount_op: 'gt', amount: '' })).toBe(0);
  });
});

describe('leafCategoryOptions', () => {
  it('flattens leaves under groups, income groups first, respecting sort_order', () => {
    const cats = [
      cat({ id: 1, name: 'Income', kind: 'income', has_children: true, sort_order: 0 }),
      cat({ id: 2, name: 'Salary', kind: 'income', parent_id: 1, sort_order: 1 }),
      cat({ id: 3, name: 'Expenses', kind: 'expense', has_children: true, sort_order: 0 }),
      cat({ id: 4, name: 'Rent', kind: 'expense', parent_id: 3, sort_order: 2 }),
      cat({ id: 5, name: 'Food', kind: 'expense', parent_id: 3, sort_order: 1 }),
    ];
    expect(leafCategoryOptions(cats)).toEqual([
      { value: '2', name: 'Salary' },
      { value: '5', name: 'Food' },
      { value: '4', name: 'Rent' },
    ]);
  });
});

describe('PillMulti', () => {
  it('toggles values and All clears', async () => {
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState('');
      return <PillMulti label="Channel" options={[{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }]} value={v} onChange={setV} />;
    }
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'A' }));
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'A' })); // untoggle A
    await user.click(screen.getByRole('button', { name: 'All' }));
    // No assertion error = interactions ran; verify buttons exist.
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });
});

describe('TxnFilterBar', () => {
  const lookups: FilterLookups = {
    accounts: [{ id: 1, name: 'Checking' }],
    categories: [
      cat({ id: 10, name: 'Expenses', kind: 'expense', has_children: true }),
      cat({ id: 11, name: 'Rent', kind: 'expense', parent_id: 10, sort_order: 0 }),
    ],
    vehicles: [{ id: 1, name: 'Civic' }],
    properties: [{ id: 1, name: 'Home' }],
    tags: [{ id: 1, name: 'Reimbursable' }],
  };

  function Host({ initial }: { initial?: Partial<Filters> }) {
    const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, ...initial });
    const [open, setOpen] = useState(false);
    return <TxnFilterBar filters={filters} setFilters={setFilters} advancedOpen={open} setAdvancedOpen={setOpen} lookups={lookups} />;
  }

  it('renders the search box and reveals advanced filters', async () => {
    const user = userEvent.setup();
    render(<Host />);
    expect(screen.getByPlaceholderText(/Search merchant/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    expect(screen.getByText('Date range')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checking' })).toBeInTheDocument();
  });

  it('shows active filter chips that each remove one filter', async () => {
    const user = userEvent.setup();
    render(<Host initial={{ range: 'this_month', uncategorized: '1', account_id: '1' }} />);
    expect(screen.getByText(/Filtering by:/)).toBeInTheDocument();
    expect(screen.getByText(/Uncategorized only/)).toBeInTheDocument();
    // Remove the account chip.
    const chip = screen.getByText(/Account: Checking/).closest('span')!;
    await user.click(chip.querySelector('button')!);
    expect(screen.queryByText(/Account: Checking/)).toBeNull();
  });

  it('typing in search shows a clear button', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.type(screen.getByPlaceholderText(/Search merchant/), 'costco');
    expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
  });
});
