import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GroceryAnalysis from './GroceryAnalysis';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api } from '../api';

const overview = (over: Partial<any> = {}) => ({
  total_spend: 1234.5, item_count: 42, product_count: 30, first_date: '2026-01-01', last_date: '2026-08-01',
  categories: ['Produce', 'Dairy', 'Meat', 'Bakery', 'Snacks', 'Frozen', 'Beverages', 'Household'],
  by_category: [{ category: 'Produce', spend: 500, items: 20 }, { category: 'Dairy', spend: 300, items: 12 }],
  by_month: [
    { month: '2026-01', Produce: 100, Dairy: 50, Household: 10 },
    { month: '2026-02', Produce: 120, Dairy: 60, Household: 20 },
  ],
  ...over,
});

const product = (over: Partial<any> = {}) => ({
  name: 'Milk', brand: 'Farm', category: 'Dairy', unit: 'gal',
  purchases: 5, total_qty: 5, total_spend: 20,
  avg_uom_price: 4, first_uom_price: 3, last_uom_price: 5, last_purchased: '2026-08-01', ...over,
});

const setup = (opts: {
  overview?: any; products?: any[]; total?: number; report?: any[]; history?: any[];
} = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path.startsWith('/receipt-items/overview')) return Promise.resolve(opts.overview ?? overview());
    if (path.startsWith('/receipt-items/products')) return Promise.resolve({ products: opts.products ?? [product()], total: opts.total ?? 1 });
    if (path.startsWith('/receipt-items/product?')) return Promise.resolve(opts.history ?? []);
    if (path.startsWith('/analysis?kind=receipt_products')) return Promise.resolve(opts.report ?? []);
    return Promise.resolve({});
  });
};

describe('GroceryAnalysis page', () => {
  beforeEach(() => vi.clearAllMocks());
  const renderPage = () => render(<MemoryRouter><GroceryAnalysis /></MemoryRouter>);

  it('renders the empty state when no items are logged', async () => {
    setup({ overview: overview({ item_count: 0 }) });
    renderPage();
    await waitFor(() => expect(screen.getByText('No itemized receipts yet')).toBeInTheDocument());
  });

  it('renders stats, charts and the product table', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('$1,234.50')).toBeInTheDocument());
    expect(screen.getByText('Spend Over Time')).toBeInTheDocument();
    expect(screen.getByText('Milk')).toBeInTheDocument();
    // price delta +67% (3 -> 5)
    expect(screen.getByText('+67%')).toBeInTheDocument();
  });

  it('shows the no-products row when the list is empty', async () => {
    setup({ products: [], total: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByText('No products in this category yet.')).toBeInTheDocument());
  });

  it('handles a product with no price data (dash delta)', async () => {
    setup({ products: [product({ first_uom_price: null, last_uom_price: null, avg_uom_price: null })] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('filters by category', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    const user = userEvent.setup();
    // The category filter is the last select (inside the Top Products card).
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[selects.length - 1], 'Dairy');
    await waitFor(() => expect((api.get as any).mock.calls.some((c: any[]) => String(c[0]).includes('category=Dairy'))).toBe(true));
  });

  it('changes the months window', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    const user = userEvent.setup();
    const monthsSelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(monthsSelect, '24');
    await waitFor(() => expect((api.get as any).mock.calls.some((c: any[]) => String(c[0]).includes('months=24'))).toBe(true));
  });

  it('opens a product and renders its price history chart', async () => {
    setup({ history: [{ date: '2026-01-01', store: 'Mart', quantity: 1, total_price: 4, uom_price: 4, size: 1, unit: 'gal' }] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Milk'));
    await waitFor(() => expect(screen.getByText('Mart')).toBeInTheDocument());
    // Close the detail card.
    await user.click(screen.getByText('Close'));
    await waitFor(() => expect(screen.queryByText('Mart')).toBeNull());
  });

  it('opens a product with no per-unit history (shows the note)', async () => {
    setup({ history: [{ date: '2026-01-01', store: null, quantity: 2, total_price: 8, uom_price: null, size: null, unit: null }] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Milk'));
    await waitFor(() => expect(screen.getByText(/No per-unit price history/)).toBeInTheDocument());
  });

  it('shows an existing AI report and re-runs it', async () => {
    setup({ report: [{ result: '# Report\n\nInsights here.', created_at: '2026-08-10' }] });
    (api.post as any).mockResolvedValue({ result: '# New\n\nFresh insights.' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Report')).toBeInTheDocument());
    expect(screen.getByText('Re-run')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText('Re-run'));
    expect(api.post).toHaveBeenCalledWith('/analysis/products', {});
    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument());
  });

  it('generates a report when none exists and handles errors', async () => {
    setup({ report: [] });
    (api.post as any).mockRejectedValue(new Error('gen failed'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Generate Report')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Generate Report'));
    await waitFor(() => expect(screen.getByText('gen failed')).toBeInTheDocument());
  });

  it('surfaces an overview load error', async () => {
    (api.get as any).mockImplementation((path: string) => {
      if (path.startsWith('/receipt-items/overview')) return Promise.reject(new Error('ov boom'));
      if (path.startsWith('/receipt-items/products')) return Promise.resolve({ products: [], total: 0 });
      return Promise.resolve([]);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('ov boom')).toBeInTheDocument());
  });
});
