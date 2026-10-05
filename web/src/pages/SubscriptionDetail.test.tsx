import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionDetail from './SubscriptionDetail';
import { todayStr } from '../api';

const navigateMock = vi.fn();
let routeId = '1';
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock, useParams: () => ({ subscriptionId: routeId }) };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

vi.mock('./transactions/TxnEditor', () => ({
  TxnEditor: (p: any) => (
    <div data-testid="txn-editor">
      <span>editor:edit-{p.txn.id}</span>
      <button onClick={p.onClose}>Editor Close</button>
      <button onClick={p.onSaved}>Editor Save</button>
    </div>
  ),
}));
vi.mock('../components/EntityDocuments', () => ({
  EntityDocuments: (p: any) => <div data-testid="documents">docs:{p.basePath}</div>,
}));

const daysOut = (n: number) => {
  const d = new Date(`${todayStr()}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const sub = (over: Partial<any> = {}): any => ({
  id: 1, name: 'Netflix', amount: 17.99, billing_cycle: 'monthly',
  next_due_date: daysOut(20), category_id: null, account_id: 9, status: 'active',
  start_date: '2026-01-01', notes: null, tier: 'Standard', service_type: 'streaming',
  end_date: null, login_url: null, login_id: null, website_url: null, phone: null,
  category_name: null, account_name: 'Visa', monthly_amount: 17.99, yearly_amount: 215.88, doc_count: 0, ...over,
});

const charge = (over: Partial<any> = {}): any => ({
  sub_id: 1, id: 300, txn_date: '2026-08-01', posted_date: '2026-08-02',
  amount: 17.99, merchant: 'Netflix', description: null, account_name: 'Visa', ...over,
});

const txn = (over: Partial<any> = {}): any => ({
  id: 300, account_id: 9, category_id: null, transfer_account_id: null,
  txn_date: '2026-08-01', posted_date: '2026-08-02', amount: 17.99,
  principal_amount: null, interest_category_id: null, direction: 'expense',
  merchant: 'Netflix', description: null, purchaser: null, channel: null, source: null,
  category_name: null, account_name: 'Visa', transfer_account_name: null,
  has_receipt: false, tags: [], splits: [], has_splits: false, ...over,
});

const accounts = [
  { id: 9, name: 'Visa', type: 'credit_card', archived_at: null },
  { id: 10, name: 'Checking', type: 'checking', archived_at: null },
];

interface Opts {
  subs?: any[]; charges?: any[]; chargeTotal?: number; chargeCount?: number;
  prices?: any[]; txns?: any[]; txnPages?: any[]; subsError?: string;
}

const setup = (o: Opts = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/subscriptions') {
      return o.subsError ? Promise.reject(new Error(o.subsError)) : Promise.resolve(o.subs ?? [sub()]);
    }
    if (path === '/subscriptions/1/price-history') return Promise.resolve(o.prices ?? []);
    if (path === '/subscriptions/1/charges') {
      const charges = o.charges ?? [];
      return Promise.resolve({ charges, total: o.chargeTotal ?? 0, count: o.chargeCount ?? charges.length });
    }
    if (path.startsWith('/transactions?subscription_id=1')) {
      if (o.txnPages) {
        const m = /pendingOffset=(\d+)&postedOffset=(\d+)/.exec(path)!;
        const idx = Number(m[2]) > 0 || Number(m[1]) > 0 ? 1 : 0;
        return Promise.resolve(o.txnPages[idx] ?? { pending: [], pendingTotal: 0, posted: [], total: 0 });
      }
      const posted = o.txns ?? [];
      return Promise.resolve({ pending: [], pendingTotal: 0, posted, total: posted.length });
    }
    if (path === '/transactions/merchants') return Promise.resolve(['Netflix']);
    if (path === '/accounts') return Promise.resolve(accounts);
    if (path === '/categories' || path === '/vehicles' || path === '/properties' || path === '/tags') return Promise.resolve([]);
    return Promise.resolve([]);
  });
  (api.post as any).mockResolvedValue({ id: 42 });
  (api.put as any).mockResolvedValue(sub());
  (api.del as any).mockResolvedValue({});
};

const renderPage = () => render(<MemoryRouter><SubscriptionDetail /></MemoryRouter>);
const openTab = (name: string) => userEvent.click(screen.getByRole('button', { name }));

describe('SubscriptionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = '1';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the header and the overview tiles', async () => {
    setup({ charges: [charge()], chargeTotal: 17.99, chargeCount: 1 });
    renderPage();
    expect(await screen.findByRole('heading', { name: /Netflix/ })).toBeInTheDocument();
    const head = screen.getByRole('heading', { level: 1 });
    expect(within(head).getByText('Standard')).toBeInTheDocument();
    expect(within(head).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('TV / Streaming · Monthly')).toBeInTheDocument();
    expect(screen.getByText('/ month')).toBeInTheDocument();
    expect(screen.getByText('Billing Cycle')).toBeInTheDocument();
    expect(screen.getByText('Amount per Cycle')).toBeInTheDocument();
    expect(screen.getByText('$17.99 · 1 payment')).toBeInTheDocument();
    const acct = screen.getByText('Account').closest('.detail-row') as HTMLElement;
    expect(within(acct).getByText('Visa')).toBeInTheDocument();
  });

  it('shows the server yearly cost rather than the rounded monthly cost × 12', async () => {
    setup({ subs: [sub({ billing_cycle: 'yearly', amount: 139, monthly_amount: 11.58, yearly_amount: 139 })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    const row = screen.getAllByText('Cost / Year').map((el) => el.closest('.detail-row')).find(Boolean) as HTMLElement;
    expect(within(row).getByText('$139.00')).toBeInTheDocument();
    expect(screen.queryByText('$138.96')).toBeNull();
  });

  it('reports an invalid id', async () => {
    routeId = 'abc';
    renderPage();
    expect(await screen.findByText('Invalid subscription.')).toBeInTheDocument();
  });

  it('reports a subscription that is not in the list', async () => {
    setup({ subs: [sub({ id: 99 })] });
    renderPage();
    expect(await screen.findByText('Subscription not found.')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    setup({ subsError: 'subs boom' });
    renderPage();
    expect(await screen.findByText('subs boom')).toBeInTheDocument();
  });

  it('pluralizes the payment count', async () => {
    setup({ charges: [charge(), charge({ id: 301 })], chargeTotal: 35.98, chargeCount: 2 });
    renderPage();
    expect(await screen.findByText('$35.98 · 2 payments')).toBeInTheDocument();
  });

  it('links a website, phone, login id and portal', async () => {
    setup({ subs: [sub({ website_url: 'netflix.com', phone: '8005550100', login_id: 'ada', login_url: 'netflix.com/account' })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    expect(screen.getByRole('link', { name: 'Visit ↗' })).toHaveAttribute('href', 'https://netflix.com');
    expect(screen.getByRole('link', { name: 'Log In ↗' })).toHaveAttribute('href', 'https://netflix.com/account');
    expect(screen.getByRole('link', { name: '(800) 555-0100' })).toHaveAttribute('href', 'tel:8005550100');
    expect(screen.getByText('ada')).toBeInTheDocument();
  });

  it('describes a canceled subscription instead of a renewal', async () => {
    setup({ subs: [sub({ status: 'canceled', end_date: '2026-07-01' })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    const head = screen.getByRole('heading', { level: 1 });
    expect(within(head).getByText('Canceled')).toBeInTheDocument();
    expect(screen.getAllByText('canceled').length).toBeGreaterThan(0);
  });

  it('describes a scheduled cancellation', async () => {
    setup({ subs: [sub({ next_due_date: daysOut(40), end_date: daysOut(10) })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    expect(screen.getAllByText(/cancels /).length).toBeGreaterThan(0);
  });

  it('shows a renewal that lands before a scheduled cancellation', async () => {
    setup({ subs: [sub({ next_due_date: daysOut(2), end_date: daysOut(40) })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    expect(screen.getAllByText(/in 2 days/).length).toBeGreaterThan(0);
  });

  it('shows a price history once there are two points', async () => {
    setup({
      prices: [
        { id: 2, amount: 17.99, billing_cycle: 'monthly', effective_date: '2026-06-01' },
        { id: 1, amount: 15.49, billing_cycle: null, effective_date: '2026-01-01' },
      ],
    });
    renderPage();
    expect(await screen.findByText('Price History')).toBeInTheDocument();
    expect(screen.getByText('+$2.50')).toBeInTheDocument();
    // The oldest row has no prior price to compare against, and no cycle recorded.
    const rows = screen.getAllByRole('row');
    expect(within(rows[rows.length - 1]).getAllByText('—')).toHaveLength(2);
  });

  it('hides the price history with a single point', async () => {
    setup({ prices: [{ id: 1, amount: 17.99, billing_cycle: 'monthly', effective_date: '2026-01-01' }] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    expect(screen.queryByText('Price History')).toBeNull();
  });

  it('shows a price drop as a credit', async () => {
    setup({
      prices: [
        { id: 2, amount: 12.99, billing_cycle: 'monthly', effective_date: '2026-06-01' },
        { id: 1, amount: 15.49, billing_cycle: 'monthly', effective_date: '2026-01-01' },
      ],
    });
    renderPage();
    expect(await screen.findByText('−$2.50')).toBeInTheDocument();
  });

  it('mounts the documents tab against this subscription', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Documents');
    expect(screen.getByText('docs:/subscriptions/1')).toBeInTheDocument();
  });
});

describe('SubscriptionDetail charges tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = '1';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('explains an empty charges list', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    expect(screen.getByText(/No charges recorded for this subscription yet/)).toBeInTheDocument();
  });

  it('groups pending and posted charges', async () => {
    setup({
      charges: [charge(), charge({ id: 301, posted_date: null, txn_date: '2026-08-20' })],
      chargeTotal: 35.98, chargeCount: 2,
    });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    expect(screen.getByText('Pending · 1 awaiting posting')).toBeInTheDocument();
    expect(screen.getByText('Posted', { selector: '.label' })).toBeInTheDocument();
    expect(screen.getByText('Pending', { selector: '.tag' })).toBeInTheDocument();
  });

  it('titles the single group Charges when nothing is pending', async () => {
    setup({ charges: [charge()], chargeTotal: 17.99, chargeCount: 1 });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    expect(screen.getByText('Charges', { selector: '.label' })).toBeInTheDocument();
  });

  it('shows a dash for a charge with no dates or account', async () => {
    setup({ charges: [charge({ posted_date: null, txn_date: null, account_name: null })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    const row = screen.getByText('Pending', { selector: '.tag' }).closest('tr') as HTMLElement;
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('logs a payment after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ charges: [charge()] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    await userEvent.click(screen.getByRole('button', { name: 'Log Payment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/1/pay'));
  });

  it('skips the payment when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    await userEvent.click(screen.getByRole('button', { name: 'Log Payment' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('reports a failed payment', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.post as any).mockRejectedValue(new Error('pay boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    await userEvent.click(screen.getByRole('button', { name: 'Log Payment' }));
    expect(await screen.findByText('pay boom')).toBeInTheDocument();
  });

  it('offers no payment button for a canceled subscription', async () => {
    setup({ subs: [sub({ status: 'canceled', end_date: '2026-07-01' })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    expect(screen.queryByRole('button', { name: 'Log Payment' })).toBeNull();
  });

  it('opens the transaction behind a charge', async () => {
    setup({ charges: [charge()], txns: [txn()], chargeTotal: 17.99, chargeCount: 1 });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/transactions/merchants'));
    await userEvent.click(screen.getByText('Visa', { selector: 'td' }));
    expect(await screen.findByText('editor:edit-300')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Save' }));
    await waitFor(() => expect(screen.queryByTestId('txn-editor')).toBeNull());
  });

  it('ignores a charge with no matching transaction', async () => {
    setup({ charges: [charge({ id: 999 })], txns: [txn()] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Charges');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/transactions/merchants'));
    await userEvent.click(screen.getByText('Visa', { selector: 'td' }));
    expect(screen.queryByTestId('txn-editor')).toBeNull();
  });

  it('pages through every transaction page', async () => {
    setup({
      txnPages: [
        { pending: [], pendingTotal: 0, posted: [txn({ id: 300 })], total: 2 },
        { pending: [], pendingTotal: 0, posted: [txn({ id: 301 })], total: 2 },
      ],
      charges: [charge({ id: 301 })],
    });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await waitFor(() => {
      const paths = (api.get as any).mock.calls.map((c: any[]) => c[0] as string);
      expect(paths.some((p: string) => p.includes('postedOffset=1'))).toBe(true);
    });
  });
});

describe('SubscriptionDetail details tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = '1';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('edits and saves the info form', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    expect(screen.getByText('Subscription Details')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Notes'), 'shared');
    await userEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/subscriptions/1', expect.objectContaining({ notes: 'shared' })));
  });

  it('validates the name and amount', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), 'Netflix');
    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Amount must be greater than 0.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('reports a save failure', async () => {
    (api.put as any).mockRejectedValue(new Error('save boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.type(screen.getByLabelText('Notes'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('save boom')).toBeInTheDocument();
  });

  it('only offers payable accounts, keeping the current one', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    const opts = within(screen.getByLabelText('Account')).getAllByRole('option').map((o) => (o as HTMLOptionElement).textContent);
    expect(opts).toContain('Visa');
    expect(opts).toContain('Checking');
  });

  it('formats a phone on blur and enables Open for a real url', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    const phone = screen.getByLabelText('Phone');
    await userEvent.type(phone, '8005550100');
    await userEvent.tab();
    expect(phone).toHaveValue('(800) 555-0100');
    expect(screen.getAllByRole('button', { name: 'Open' })[0]).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Web Address'), 'netflix.com');
    expect(screen.getAllByRole('button', { name: 'Open' })[0]).toBeEnabled();
  });

  it('opens a web address in a new tab', async () => {
    setup({ subs: [sub({ website_url: 'netflix.com' })] });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]);
    expect(open).toHaveBeenCalledWith('https://netflix.com', '_blank', 'noopener');
  });

  it('deletes the subscription after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/subscriptions/1'));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions');
  });

  it('reports a delete failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.del as any).mockRejectedValue(new Error('del boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('del boom')).toBeInTheDocument();
  });

  // ── Manage subscription ──────────────────────────────────────────────────
  it('pauses an active subscription', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/1/pause'));
  });

  it('resumes a paused subscription', async () => {
    setup({ subs: [sub({ status: 'paused' })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    expect(screen.getByText(/Paused — excluded from monthly totals/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/1/reactivate'));
  });

  it('reactivates a canceled subscription', async () => {
    setup({ subs: [sub({ status: 'canceled', end_date: '2026-07-01' })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    expect(screen.getByText(/Canceled on Jul 1, 2026 — kept for history/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate Subscription' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/1/reactivate'));
  });

  it('clears a scheduled cancellation', async () => {
    setup({ subs: [sub({ end_date: daysOut(10) })] });
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    expect(screen.getByText(/Scheduled to cancel on/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear Cancellation' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/1/reactivate'));
  });

  it('cancels a subscription through the inline form', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Subscription' }));
    expect(screen.getByText(/Cancels immediately/)).toBeInTheDocument();
    const date = screen.getByLabelText('Cancellation Date');
    await userEvent.clear(date);
    await userEvent.type(date, daysOut(30));
    expect(await screen.findByText(/Stays active until/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as Canceled' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/1/cancel', { date: daysOut(30) }));
  });

  it('backs out of the cancel form', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Subscription' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Cancellation Date')).toBeNull();
  });

  it('reports a failed cancellation', async () => {
    (api.post as any).mockRejectedValue(new Error('cancel boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Subscription' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark as Canceled' }));
    expect(await screen.findByText('cancel boom')).toBeInTheDocument();
  });

  it('reports a failed pause', async () => {
    (api.post as any).mockRejectedValue(new Error('pause boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('pause boom')).toBeInTheDocument();
  });

  it('reports a failed reactivate', async () => {
    setup({ subs: [sub({ status: 'paused' })] });
    (api.post as any).mockRejectedValue(new Error('resume boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Netflix/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('resume boom')).toBeInTheDocument();
  });
});

describe('SubscriptionDetail new mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = 'new';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the add form and creates a subscription', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add Subscription' })).toBeInTheDocument();
    expect(screen.getByText('New Subscription')).toBeInTheDocument();
    // Nothing is loaded for a brand-new subscription beyond the account list.
    const paths = (api.get as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(paths.some((p: string) => p.startsWith('/subscriptions/'))).toBe(false);

    await userEvent.type(screen.getByLabelText('Name'), 'Hulu');
    await userEvent.type(screen.getByLabelText('Amount'), '18.99');
    await userEvent.click(screen.getByRole('button', { name: 'Add Subscription' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions', expect.objectContaining({ name: 'Hulu', amount: 18.99 })));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions/42');
  });

  it('quick-fills from a preset plan', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Add Subscription' });
    expect(screen.getByLabelText('Plan')).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Quick Fill from a Service (Optional)'), 'Spotify');
    expect(screen.getByLabelText('Type')).toHaveValue('music');
    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'Family');
    expect(screen.getByLabelText('Name')).toHaveValue('Spotify');
    expect(screen.getByLabelText('Tier / Plan')).toHaveValue('Family');
    expect(screen.getByLabelText('Amount')).toHaveValue('$21.99');
  });

  it('keeps an already-chosen type when picking a service', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Add Subscription' });
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'gaming');
    await userEvent.selectOptions(screen.getByLabelText('Quick Fill from a Service (Optional)'), 'Spotify');
    expect(screen.getByLabelText('Type')).toHaveValue('gaming');
  });

  it('offers no delete button in new mode', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Add Subscription' });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
