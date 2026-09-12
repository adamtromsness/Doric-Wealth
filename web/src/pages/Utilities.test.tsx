import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Utilities from './Utilities';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api } from '../api';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

const account = (over: Partial<any> = {}): any => ({
  id: 1, name: 'City Water', provider: 'City', utility_type: 'water', billing_cycle: 'monthly',
  account_number: 'A123', property_id: 7, property_name: 'Home', due_day: 15, usage_unit: 'gallons',
  notes: null, login_url: null, login_id: null, is_autopay: false, payment_method: null, meter_number: null,
  provider_phone: null, account_holder: null, rate_plan: null, provider_url: null, autopay_day: null,
  payment_plan: 'actual', payment_account_id: null, payment_account_name: null,
  status: 'active', end_date: null,
  total_billed: 300, invoice_count: 3, unpaid_amount: 50, unpaid_count: 1, ...over,
});

const invoice = (over: Partial<any> = {}): any => ({
  id: 1, provider: 'City', invoice_date: '2026-08-01', period_start: null, period_end: null,
  due_date: '2026-08-15', paid: false, paid_date: null, notes: null, channel: null,
  category_id: null, account_id: null, category_name: null, account_name: null,
  transaction_id: null, lines: [{ utility_account_id: 1, account_name: 'City Water', utility_type: 'water', description: 'Water', amount: 50, usage_quantity: 100, usage_unit: 'gallons', notes: null }],
  total: 50, late_total: null, amount_paid: 0, ...over,
});

const properties = [{ id: 7, name: 'Home' }, { id: 8, name: 'Cabin' }];

const setup = (opts: { accounts?: any[]; invoices?: any[]; properties?: any[]; failAccounts?: boolean } = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/utilities/accounts') return opts.failAccounts ? Promise.reject(new Error('acct boom')) : Promise.resolve(opts.accounts ?? [account()]);
    if (path === '/utilities/invoices') return Promise.resolve(opts.invoices ?? [invoice()]);
    if (path === '/properties') return Promise.resolve(opts.properties ?? properties);
    if (path === '/accounts') return Promise.resolve([{ id: 500, name: 'Checking', type: 'checking' }]);
    return Promise.resolve([]);
  });
};

const renderPage = () => render(<MemoryRouter><Utilities /></MemoryRouter>);

describe('Utilities page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders summary, charts and an account card once loaded', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Utilities', level: 1 })).toBeInTheDocument());
    // Scope to the account card: the by-type chart also renders the account name.
    const card = screen.getAllByTitle('View account details')[0];
    expect(within(card).getByText('City Water')).toBeInTheDocument();
    // Monthly-by-type chart labels.
    expect(screen.getByText(/Cost by Type/)).toBeInTheDocument();
    // The account card repeats the Outstanding label, so scope to the summary grid.
    const summary = screen.getByText('Cost / Month').closest('.grid') as HTMLElement;
    expect(within(summary).getByText('Outstanding')).toBeInTheDocument();
  });

  it('shows the no-properties prompt and disables Add Account', async () => {
    setup({ properties: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Add a Property/)).toBeInTheDocument());
    expect(screen.getByText('Add Account')).toBeDisabled();
  });

  it('surfaces an accounts load error', async () => {
    setup({ failAccounts: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('acct boom')).toBeInTheDocument());
  });

  it('shows the empty-accounts state when there are none', async () => {
    setup({ accounts: [], invoices: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No utility accounts yet/)).toBeInTheDocument());
  });

  it('navigates to add and to detail views', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Add Account')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Add Account'));
    expect(navigate).toHaveBeenCalledWith('/utilities/new');
    await user.click(screen.getAllByText('View Details →')[0]);
    expect(navigate).toHaveBeenCalledWith('/utilities/1');
  });

  it('toggles charts and accounts visibility (persisted)', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Hide Charts')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Hide Charts'));
    expect(localStorage.getItem('utilities.hideCharts')).toBe('1');
    await user.click(screen.getByText('Show Charts'));
    await user.click(screen.getByText('Hide Accounts'));
    expect(localStorage.getItem('utilities.hideAccounts')).toBe('1');
  });

  it('switches the chart view to yearly', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Yearly')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Yearly'));
    await waitFor(() => expect(screen.getByText(/Yearly Cost by Type/)).toBeInTheDocument());
  });

  it('filters by property via the select', async () => {
    setup({ accounts: [account(), account({ id: 2, name: 'Cabin Gas', property_id: 8, property_name: 'Cabin', utility_type: 'gas' })] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Cabin Gas')).toBeInTheDocument());
    const user = userEvent.setup();
    const propSelect = screen.getByRole('combobox');
    await user.selectOptions(propSelect, '8');
    await waitFor(() => expect(screen.queryByText('City Water')).toBeNull());
    expect(screen.getByText('Cabin Gas')).toBeInTheDocument();
  });

  it('shows the disabled-accounts section', async () => {
    setup({ accounts: [account(), account({ id: 3, name: 'Old Trash', status: 'canceled', end_date: '2026-06-01', utility_type: 'trash', unpaid_amount: 0, unpaid_count: 0 })] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Disabled Accounts/)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Show'));
    expect(screen.getByText('Old Trash')).toBeInTheDocument();
  });

  it('opens the filter panel and applies account + amount + range filters', async () => {
    setup({ invoices: [invoice(), invoice({ id: 2, total: 500, due_date: '2026-09-01', paid: true, paid_date: '2026-09-02' })] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Invoices')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText(/Filter/));
    // Account chip filter.
    await user.click(screen.getByRole('button', { name: 'City Water' }));
    // Date range chip.
    await user.click(screen.getByText('This Year'));
    // Custom range reveals date inputs.
    await user.click(screen.getByText('Custom'));
    await waitFor(() => expect(screen.getByText('From')).toBeInTheDocument());
    // Amount advanced filter.
    await user.click(screen.getByText(/Amount/));
    const opSelect = await waitFor(() => {
      const s = screen.getAllByRole('combobox').find((el) => within(el).queryByText('Greater Than'));
      if (!s) throw new Error('op select not ready');
      return s as HTMLSelectElement;
    });
    await user.selectOptions(opSelect, 'gt');
    await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument());
    // Between op reveals two inputs.
    await user.selectOptions(opSelect, 'between');
    await waitFor(() => expect(screen.getByPlaceholderText('min')).toBeInTheDocument());
    // Clear filters.
    await user.click(screen.getByText('Clear Filters'));
  });

  it('reorders accounts via drag and persists via api.post', async () => {
    setup({ accounts: [account(), account({ id: 2, name: 'Cabin Gas', property_id: 7, property_name: 'Home', utility_type: 'gas' })] });
    (api.post as any).mockResolvedValue({});
    renderPage();
    await waitFor(() => expect(screen.getByText('Cabin Gas')).toBeInTheDocument());
    const handles = screen.getAllByTitle('Drag to reorder');
    fireEvent.dragStart(handles[0]);
    // Drop onto the second card (its onDrop reads the now-set drag index).
    const cards = document.querySelectorAll('.kindcard.expense');
    fireEvent.dragOver(cards[1]);
    fireEvent.drop(cards[1]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/utilities/accounts/reorder', expect.objectContaining({ ids: expect.any(Array) })));
  });

  it('opens the add-invoice editor and closes it', async () => {
    setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Add Invoice')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Add Invoice'));
    // InvoiceEditor modal renders (has an "Add Invoice" title area / lines).
    await waitFor(() => expect(document.querySelector('.scrim')).toBeInTheDocument());
    await user.click(document.querySelector('.scrim')!);
  });

  it('paginates the paid invoices table', async () => {
    const paid = Array.from({ length: 30 }, (_, i) => invoice({ id: 100 + i, paid: true, paid_date: `2026-07-${String((i % 27) + 1).padStart(2, '0')}`, due_date: null }));
    setup({ invoices: paid });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Page 1 of/)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText(/Page 2 of/)).toBeInTheDocument());
    await user.click(screen.getByText('Previous'));
    await waitFor(() => expect(screen.getByText(/Page 1 of/)).toBeInTheDocument());
  });
});
