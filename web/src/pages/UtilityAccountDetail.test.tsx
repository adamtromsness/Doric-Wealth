import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import UtilityAccountDetail from './UtilityAccountDetail';

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
  id: 1, name: 'City Water', provider: 'City Water Co', utility_type: 'water', billing_cycle: 'monthly',
  account_number: 'A123', property_id: 7, property_name: 'Home', due_day: 15, usage_unit: 'gallons',
  notes: 'note', login_url: 'coweb.com/login', login_id: 'user1', is_autopay: true, payment_method: 'online',
  meter_number: 'M9', provider_phone: '5125550100', account_holder: 'Ada', rate_plan: 'Standard',
  provider_url: 'coweb.com', autopay_day: 5, payment_plan: 'average', payment_account_id: 500, payment_account_name: 'Checking',
  status: 'active', end_date: null,
  total_billed: 300, invoice_count: 3, unpaid_amount: 50, unpaid_count: 1, ...over,
});

const invoice = (over: Partial<any> = {}): any => ({
  id: 1, provider: 'City', invoice_date: '2026-06-01', period_start: null, period_end: null,
  due_date: '2026-06-15', paid: false, paid_date: null, notes: null, channel: null,
  category_id: null, account_id: null, category_name: null, account_name: null,
  transaction_id: null,
  lines: [{ utility_account_id: 1, account_name: 'City Water', utility_type: 'water', description: 'Water', amount: 50, usage_quantity: 100, usage_unit: 'gallons', notes: null }],
  total: 50, late_total: null, amount_paid: 0, ...over,
});

const properties = [{ id: 7, name: 'Home' }];
const banks = [{ id: 500, name: 'Checking', type: 'checking' }];

const setup = (opts: { accounts?: any[]; invoices?: any[] } = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/utilities/accounts') return Promise.resolve(opts.accounts ?? [account()]);
    if (path.startsWith('/utilities/invoices')) return Promise.resolve(opts.invoices ?? [
      invoice(),
      invoice({ id: 2, invoice_date: '2026-05-01', due_date: '2026-05-15', paid: true, paid_date: '2026-05-14', total: 40, amount_paid: 40, lines: [{ utility_account_id: 1, account_name: 'City Water', utility_type: 'water', description: 'Water', amount: 40, usage_quantity: 90, usage_unit: 'gallons', notes: null }] }),
      invoice({ id: 3, invoice_date: '2026-04-01', due_date: '2026-04-15', paid: true, paid_date: '2026-04-14', total: 30, amount_paid: 30, lines: [{ utility_account_id: 1, account_name: 'City Water', utility_type: 'water', description: 'Water', amount: 30, usage_quantity: 80, usage_unit: 'gallons', notes: null }] }),
    ]);
    if (path === '/properties') return Promise.resolve(properties);
    if (path === '/accounts') return Promise.resolve(banks);
    return Promise.resolve([]);
  });
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/utilities/:accountId" element={<UtilityAccountDetail />} />
      </Routes>
    </MemoryRouter>
  );

describe('UtilityAccountDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the add form in "new" mode and saves a new account', async () => {
    setup();
    (api.post as any).mockResolvedValue(account({ id: 9 }));
    renderAt('/utilities/new');
    await waitFor(() => expect(screen.getByText('Add Utility Account')).toBeInTheDocument());
    const user = userEvent.setup();
    // Name required.
    await user.click(screen.getByText('Add Account'));
    await waitFor(() => expect(screen.getByText('Name is required.')).toBeInTheDocument());
    const nameInput = screen.getByPlaceholderText(/City of Austin/);
    await user.type(nameInput, 'New Gas');
    await user.click(screen.getByText('Add Account'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/utilities/accounts', expect.objectContaining({ name: 'New Gas' })));
    expect(navigate).toHaveBeenCalledWith('/utilities/9');
  });

  it('shows a not-found error when the account is missing', async () => {
    setup({ accounts: [] });
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('Utility account not found.')).toBeInTheDocument());
  });

  it('shows an invalid-id error for a non-numeric id', async () => {
    setup();
    renderAt('/utilities/abc');
    await waitFor(() => expect(screen.getByText('Invalid utility account.')).toBeInTheDocument());
  });

  it('renders the overview with billing stats and charts', async () => {
    setup();
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    expect(screen.getByText('Cost Over Time')).toBeInTheDocument();
    expect(screen.getByText('Usage Over Time')).toBeInTheDocument();
    expect(screen.getByText('Average Bill')).toBeInTheDocument();
    // Website / portal links from account facts.
    expect(screen.getByText('Visit ↗')).toBeInTheDocument();
  });

  it('switches tabs to invoices, documents, and details', async () => {
    setup();
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Invoices' }));
    await waitFor(() => expect(screen.getByText('Add Invoice')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Documents' }));
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel Service' })).toBeInTheDocument());
  });

  it('opens the add-invoice editor from the invoices tab', async () => {
    setup();
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Invoices' }));
    await user.click(screen.getByText('Add Invoice'));
    await waitFor(() => expect(document.querySelector('.scrim')).toBeInTheDocument());
    await user.click(document.querySelector('.scrim')!);
  });

  it('edits and saves account details', async () => {
    setup();
    (api.put as any).mockResolvedValue(account({ name: 'Renamed' }));
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const nameInput = await screen.findByDisplayValue('City Water');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/utilities/accounts/1', expect.objectContaining({ name: 'Renamed' })));
  });

  it('deletes an account with confirmation', async () => {
    setup();
    (api.del as any).mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByText('Delete'));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/utilities/accounts/1'));
    expect(navigate).toHaveBeenCalledWith('/utilities');
  });

  it('cancels service with a chosen date', async () => {
    setup();
    (api.post as any).mockResolvedValue({});
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Cancel Service' }));
    await waitFor(() => expect(screen.getByText('Disable Service')).toBeInTheDocument());
    await user.click(screen.getByText('Disable Service'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/utilities/accounts/1/cancel', expect.objectContaining({ date: expect.any(String) })));
  });

  it('reactivates a canceled account and shows the canceled banner', async () => {
    setup({ accounts: [account({ status: 'canceled', end_date: '2026-06-01', unpaid_amount: 0, unpaid_count: 0 })] });
    (api.post as any).mockResolvedValue({});
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText(/Service canceled/)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByText('Reactivate Service'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/utilities/accounts/1/reactivate'));
  });

  it('paginates paid invoices on the invoices tab', async () => {
    const many = [
      invoice(),
      ...Array.from({ length: 30 }, (_, i) => invoice({ id: 200 + i, paid: true, paid_date: `2026-03-${String((i % 27) + 1).padStart(2, '0')}`, total: 25, amount_paid: 25 })),
    ];
    setup({ invoices: many });
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Invoices' }));
    await waitFor(() => expect(screen.getByText(/Page 1 of/)).toBeInTheDocument());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText(/Page 2 of/)).toBeInTheDocument());
    await user.click(screen.getByText('Previous'));
    await waitFor(() => expect(screen.getByText(/Page 1 of/)).toBeInTheDocument());
  });

  it('toggles autopay off in the details form', async () => {
    setup();
    renderAt('/utilities/1');
    await waitFor(() => expect(screen.getByText('City Water')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const autopay = await screen.findByRole('checkbox', { name: /autopay/i });
    await user.click(autopay);
    // Paid-From field disappears when autopay is off.
    await waitFor(() => expect(screen.queryByText('Paid From')).toBeNull());
  });
});
