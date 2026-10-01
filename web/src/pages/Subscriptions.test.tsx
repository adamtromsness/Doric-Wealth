import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Subscriptions, { SubscriptionEditor, dueInLabel, dueClass, serviceTypeLabel } from './Subscriptions';
import { todayStr } from '../api';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

// Has its own test; here it only needs to prove the page opened it.
vi.mock('../components/SubscriptionSuggestions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/SubscriptionSuggestions')>();
  return {
    ...actual,
    SubscriptionSuggestions: (p: any) => (
      <div data-testid="suggestions-modal">
        <button onClick={p.onClose}>Suggestions Close</button>
        <button onClick={p.onChanged}>Suggestions Changed</button>
      </div>
    ),
  };
});

// Dates relative to today keep the due-date labels stable whenever this runs.
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

const summary = (over: Partial<any> = {}): any => ({
  activeCount: 1, monthlyTotal: 17.99, yearlyTotal: 215.88, upcoming: [], ...over,
});

const accounts = [{ id: 9, name: 'Visa' }, { id: 10, name: 'Checking' }];

interface Opts { subs?: any[]; summary?: any; suggestions?: any[]; subsError?: string }

const setup = (o: Opts = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/subscriptions') {
      return o.subsError ? Promise.reject(new Error(o.subsError)) : Promise.resolve(o.subs ?? [sub()]);
    }
    if (path === '/subscriptions/summary') return Promise.resolve(o.summary ?? summary());
    if (path === '/subscriptions/suggestions') return Promise.resolve(o.suggestions ?? []);
    if (path === '/accounts') return Promise.resolve(accounts);
    return Promise.resolve([]);
  });
  (api.post as any).mockResolvedValue({});
  (api.put as any).mockResolvedValue({});
  (api.del as any).mockResolvedValue({});
};

const renderPage = () => render(<MemoryRouter><Subscriptions /></MemoryRouter>);

describe('Subscriptions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the header, summary tiles and a subscription card', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Subscriptions', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Active Subscriptions', { selector: '.label' })).toBeInTheDocument();
    expect(screen.getByText('Cost / Month')).toBeInTheDocument();
    expect(screen.getByText('Cost / Year')).toBeInTheDocument();
    const yearTile = screen.getByText('Cost / Year').closest('.stat') as HTMLElement;
    expect(within(yearTile).getByText('$215.88')).toBeInTheDocument();
    expect(screen.getByText('Renewing in 30 Days')).toBeInTheDocument();
    expect(screen.getByText('nothing due')).toBeInTheDocument();

    const card = screen.getByTitle('View subscription details');
    expect(within(card).getByText('Netflix')).toBeInTheDocument();
    expect(within(card).getByText('Standard')).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(within(card).getByText(/TV \/ Streaming · \$17\.99\/mo/)).toBeInTheDocument();
    expect(within(card).getByText('Share of monthly spend')).toBeInTheDocument();
    expect(within(card).getByText('100%')).toBeInTheDocument();
    expect(within(card).getByText('Member since')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    setup({ subsError: 'subs boom' });
    renderPage();
    expect(await screen.findByText('subs boom')).toBeInTheDocument();
  });

  it('shows the first-run empty state', async () => {
    setup({ subs: [], summary: summary({ activeCount: 0, monthlyTotal: 0, yearlyTotal: 0 }) });
    renderPage();
    expect(await screen.findByText(/No subscriptions yet\./)).toBeInTheDocument();
  });

  it('shows a filter-specific empty state', async () => {
    setup({ subs: [sub()] });
    renderPage();
    await screen.findByTitle('View subscription details');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'paused');
    expect(await screen.findByText('No subscriptions match this filter.')).toBeInTheDocument();
  });

  it('navigates to the add page and to a detail page', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add Subscription' }));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions/new');
    navigateMock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /View Details/ }));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions/1');
    navigateMock.mockClear();
    await userEvent.click(screen.getByTitle('View subscription details'));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions/1');
  });

  it('offers the suggestions review and reloads after a change', async () => {
    setup({ suggestions: [{ merchant: 'Spotify', key: 'spotify', amount: 11.99, billing_cycle: 'monthly', count: 3, last_date: '2026-08-01', next_due_date: '2026-09-01', interval_days: 30, transactions: [] }] });
    renderPage();
    expect(await screen.findByText('1 possible subscription')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByTestId('suggestions-modal')).toBeInTheDocument();
    const before = (api.get as any).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Suggestions Changed' }));
    await waitFor(() => expect((api.get as any).mock.calls.length).toBeGreaterThan(before));
    await userEvent.click(screen.getByRole('button', { name: 'Suggestions Close' }));
    expect(screen.queryByTestId('suggestions-modal')).toBeNull();
  });

  it('pluralizes the suggestions banner', async () => {
    const s = (k: string) => ({ merchant: k, key: k, amount: 1, billing_cycle: 'monthly', count: 3, last_date: '2026-08-01', next_due_date: '2026-09-01', interval_days: 30, transactions: [] });
    setup({ suggestions: [s('a'), s('b')] });
    renderPage();
    expect(await screen.findByText('2 possible subscriptions')).toBeInTheDocument();
  });

  it('lists renewals due in the next 30 days', async () => {
    const due = sub({ next_due_date: daysOut(3) });
    setup({ subs: [due], summary: summary({ upcoming: [due] }) });
    renderPage();
    expect(await screen.findByText('Renewing in the Next 30 Days')).toBeInTheDocument();
    expect(screen.getByText('$17.99 due')).toBeInTheDocument();
  });

  it('toggles the charts and remembers the choice', async () => {
    renderPage();
    await screen.findByTitle('View subscription details');
    expect(screen.getByText('Monthly Spend by Type')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide Charts' }));
    expect(localStorage.getItem('subscriptions.hideCharts')).toBe('1');
    expect(screen.queryByText('Monthly Spend by Type')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show Charts' }));
    expect(localStorage.getItem('subscriptions.hideCharts')).toBe('0');
  });

  it('starts with charts hidden when storage says so', async () => {
    localStorage.setItem('subscriptions.hideCharts', '1');
    renderPage();
    await screen.findByTitle('View subscription details');
    expect(screen.getByRole('button', { name: 'Show Charts' })).toBeInTheDocument();
  });

  it('switches the charts to a yearly view', async () => {
    renderPage();
    await screen.findByTitle('View subscription details');
    await userEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    expect(screen.getByText('Yearly Spend by Type')).toBeInTheDocument();
    expect(screen.getByText('Yearly Cost by Subscription')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(screen.getByText('Monthly Spend by Type')).toBeInTheDocument();
  });

  it('caps the per-subscription chart at the top eight', async () => {
    const many = Array.from({ length: 9 }, (_, i) => sub({ id: i + 1, name: `Svc ${i + 1}`, monthly_amount: i + 1, yearly_amount: (i + 1) * 12 }));
    setup({ subs: many });
    renderPage();
    expect(await screen.findByText('Monthly Cost by Subscription (top 8)')).toBeInTheDocument();
  });

  it('groups unspecified service types in the chart', async () => {
    setup({ subs: [sub({ service_type: null })] });
    renderPage();
    await screen.findByTitle('View subscription details');
    expect(screen.getByText(/Unspecified/)).toBeInTheDocument();
  });

  it('hides the chart controls when nothing is active', async () => {
    setup({ subs: [sub({ status: 'canceled' })] });
    renderPage();
    // The default filter is active-only, so the list is empty and charts have no data.
    expect(await screen.findByText('No subscriptions match this filter.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide Charts' })).toBeNull();
    expect(screen.queryByText(/Spend by Type/)).toBeNull();
  });

  // ── statuses and filters ─────────────────────────────────────────────────
  it('shows a paused subscription without a next due date', async () => {
    setup({ subs: [sub({ status: 'paused', next_due_date: daysOut(5) })] });
    renderPage();
    const card = await screen.findByTitle('View subscription details');
    expect(within(card).getByText('Paused', { selector: '.muted' })).toBeInTheDocument();
    expect(within(card).getByText('Paused', { selector: '.value' })).toBeInTheDocument();
  });

  it('shows an em dash when an active subscription has no due date', async () => {
    setup({ subs: [sub({ next_due_date: null })] });
    renderPage();
    const card = await screen.findByTitle('View subscription details');
    expect(within(card).getByText('—')).toBeInTheDocument();
  });

  it('flags an overdue renewal', async () => {
    setup({ subs: [sub({ next_due_date: daysOut(-2) })] });
    renderPage();
    const card = await screen.findByTitle('View subscription details');
    expect(within(card).getByText('2 days overdue')).toBeInTheDocument();
  });

  it('flags a renewal due soon', async () => {
    setup({ subs: [sub({ next_due_date: daysOut(1) })] });
    renderPage();
    const card = await screen.findByTitle('View subscription details');
    expect(within(card).getByText('tomorrow')).toBeInTheDocument();
  });

  it('shows notes and a scheduled cancellation on the card', async () => {
    setup({ subs: [sub({ notes: 'shared with family', end_date: daysOut(40) })] });
    renderPage();
    const card = await screen.findByTitle('View subscription details');
    expect(within(card).getByText('shared with family')).toBeInTheDocument();
    expect(within(card).getByText('Cancels')).toBeInTheDocument();
  });

  it('filters to every subscription, including cancelled ones', async () => {
    setup({ subs: [sub(), sub({ id: 2, name: 'Old Thing', status: 'canceled', end_date: '2026-03-01' })] });
    renderPage();
    await screen.findByTitle('View subscription details');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'all');
    expect(await screen.findByRole('heading', { name: 'All Subscriptions' })).toBeInTheDocument();
    const cards = screen.getAllByTitle('View subscription details');
    expect(cards).toHaveLength(2);
    expect(within(cards[1]).getByText('Old Thing')).toBeInTheDocument();
    // The separate cancelled section is redundant here.
    expect(screen.queryByText(/Cancelled Subscriptions ·/)).toBeNull();
  });

  it('filters to cancelled subscriptions only', async () => {
    setup({ subs: [sub(), sub({ id: 2, name: 'Old Thing', status: 'canceled' })] });
    renderPage();
    await screen.findByTitle('View subscription details');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'canceled');
    expect(await screen.findByRole('heading', { name: 'Cancelled' })).toBeInTheDocument();
    const cards = screen.getAllByTitle('View subscription details');
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText('Old Thing')).toBeInTheDocument();
  });

  it('shows and hides the separate cancelled section', async () => {
    setup({
      subs: [sub(), sub({ id: 2, name: 'Old Thing', status: 'canceled', start_date: '2025-01-01', end_date: '2026-03-01', amount: 9.99, monthly_amount: 9.99, yearly_amount: 119.88 })],
    });
    renderPage();
    expect(await screen.findByText('Cancelled Subscriptions · 1')).toBeInTheDocument();
    // Hidden by default.
    expect(screen.queryByText('Old Thing')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(localStorage.getItem('subscriptions.showCancelled')).toBe('1');
    const card = screen.getByText('Old Thing').closest('.kindcard') as HTMLElement;
    expect(within(card).getByText('Canceled')).toBeInTheDocument();
    expect(within(card).getByText(/Was:/)).toBeInTheDocument();
    expect(within(card).getByText(/\$9\.99 \/ monthly/)).toBeInTheDocument();
    expect(within(card).getByText(/Active:/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(localStorage.getItem('subscriptions.showCancelled')).toBe('0');
  });

  it('opens a cancelled subscription from its card', async () => {
    localStorage.setItem('subscriptions.showCancelled', '1');
    setup({ subs: [sub(), sub({ id: 2, name: 'Old Thing', status: 'canceled' })] });
    renderPage();
    const card = (await screen.findByText('Old Thing')).closest('.kindcard') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: /View Details/ }));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions/2');
  });

  // ── reordering ───────────────────────────────────────────────────────────
  it('persists a drag reorder of the active list', async () => {
    setup({ subs: [sub({ id: 1, name: 'First' }), sub({ id: 2, name: 'Second' })] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTitle('View subscription details')).toHaveLength(2));
    const cards = screen.getAllByTitle('View subscription details');
    fireEvent.dragStart(within(cards[0]).getByTitle('Drag to reorder'));
    fireEvent.dragOver(cards[1]);
    fireEvent.drop(cards[1]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/reorder', { ids: [2, 1] }));
  });

  it('reports a failed reorder', async () => {
    setup({ subs: [sub({ id: 1, name: 'First' }), sub({ id: 2, name: 'Second' })] });
    (api.post as any).mockRejectedValue(new Error('reorder boom'));
    renderPage();
    await waitFor(() => expect(screen.getAllByTitle('View subscription details')).toHaveLength(2));
    const cards = screen.getAllByTitle('View subscription details');
    fireEvent.dragStart(within(cards[0]).getByTitle('Drag to reorder'));
    fireEvent.dragOver(cards[1]);
    fireEvent.drop(cards[1]);
    expect(await screen.findByText('reorder boom')).toBeInTheDocument();
  });

  it('ignores a drop back onto the same slot', async () => {
    setup({ subs: [sub({ id: 1, name: 'First' }), sub({ id: 2, name: 'Second' })] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTitle('View subscription details')).toHaveLength(2));
    const cards = screen.getAllByTitle('View subscription details');
    fireEvent.dragStart(within(cards[0]).getByTitle('Drag to reorder'));
    fireEvent.drop(cards[0]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not offer drag handles outside the active filter', async () => {
    setup({ subs: [sub({ id: 1, name: 'First' }), sub({ id: 2, name: 'Second' })] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTitle('View subscription details')).toHaveLength(2));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'all');
    await waitFor(() => expect(screen.queryAllByTitle('Drag to reorder')).toHaveLength(0));
  });
});

describe('Subscriptions helpers', () => {
  it('labels due dates relative to today', () => {
    expect(dueInLabel(null)).toBe('—');
    expect(dueInLabel(daysOut(0))).toBe('today');
    expect(dueInLabel(daysOut(1))).toBe('tomorrow');
    expect(dueInLabel(daysOut(4))).toBe('in 4 days');
    expect(dueInLabel(daysOut(-1))).toBe('1 day overdue');
    expect(dueInLabel(daysOut(-3))).toBe('3 days overdue');
  });

  it('classes due dates by urgency', () => {
    expect(dueClass(null)).toBe('');
    expect(dueClass(daysOut(-1))).toBe('debit');
    expect(dueClass(daysOut(3))).toBe('warn');
    expect(dueClass(daysOut(40))).toBe('');
  });

  it('labels service types, falling back to the raw value', () => {
    expect(serviceTypeLabel(null)).toBe('—');
    expect(serviceTypeLabel('music')).toBe('Music');
    expect(serviceTypeLabel('unknown-kind')).toBe('unknown-kind');
  });
});

describe('SubscriptionEditor', () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const renderEditor = (s: any = null) =>
    render(<MemoryRouter><SubscriptionEditor sub={s} accounts={accounts} onClose={onClose} onSaved={onSaved} /></MemoryRouter>);

  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a subscription and keeps Add disabled until something changes', async () => {
    renderEditor();
    expect(screen.getByText('Add Subscription')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Name'), 'Hulu');
    await userEvent.type(screen.getByLabelText('Amount'), '18.99');
    await userEvent.selectOptions(screen.getByLabelText('Account'), '10');
    await userEvent.click(add);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions', expect.objectContaining({
      name: 'Hulu', amount: 18.99, billing_cycle: 'monthly', account_id: 10, status: 'active', end_date: null,
    })));
    expect(onSaved).toHaveBeenCalled();
  });

  it('requires a name', async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText('Amount'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('requires a positive amount', async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText('Name'), 'Hulu');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Amount must be greater than 0.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Amount'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Amount must be greater than 0.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('quick-fills name, tier, price and cycle from a preset plan', async () => {
    renderEditor();
    expect(screen.getByLabelText('Plan')).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Quick Fill from a Service (Optional)'), 'Netflix');
    const plan = screen.getByLabelText('Plan');
    expect(plan).toBeEnabled();
    // Choosing the service also seeds its usual type.
    expect(screen.getByLabelText('Type')).toHaveValue('streaming');
    await userEvent.selectOptions(plan, 'Premium 4K');
    expect(screen.getByLabelText('Name')).toHaveValue('Netflix');
    expect(screen.getByLabelText('Tier / Plan')).toHaveValue('Premium 4K');
    expect(screen.getByLabelText('Amount')).toHaveValue('24.99');
    expect(screen.getByLabelText('Billing Cycle')).toHaveValue('monthly');
  });

  it('carries a yearly cycle through from a preset plan', async () => {
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText('Quick Fill from a Service (Optional)'), 'Costco');
    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'Executive');
    // AmountInput normalizes a whole-dollar preset to two decimal places.
    expect(screen.getByLabelText('Amount')).toHaveValue('130.00');
    expect(screen.getByLabelText('Billing Cycle')).toHaveValue('yearly');
    expect(screen.getByLabelText('Type')).toHaveValue('membership');
  });

  it('leaves an already-chosen type alone when picking a service', async () => {
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'software');
    await userEvent.selectOptions(screen.getByLabelText('Quick Fill from a Service (Optional)'), 'Netflix');
    expect(screen.getByLabelText('Type')).toHaveValue('software');
  });

  it('edits an existing subscription', async () => {
    renderEditor(sub());
    expect(screen.getByText('Edit Subscription')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Netflix');
    // The preset quick-fill is only offered for new subscriptions.
    expect(screen.queryByLabelText('Quick Fill from a Service (Optional)')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Tier / Plan'));
    await userEvent.type(screen.getByLabelText('Tier / Plan'), 'Premium 4K');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/subscriptions/1', expect.objectContaining({ tier: 'Premium 4K' })));
  });

  it('shows the cancellation date and explains a future cancellation', async () => {
    renderEditor();
    expect(screen.queryByLabelText('Cancellation Date')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'canceled');
    const cancelDate = screen.getByLabelText('Cancellation Date');
    expect(cancelDate).toBeInTheDocument();
    // Defaults to today, which cancels immediately.
    expect(screen.getByText('Cancels immediately.')).toBeInTheDocument();
    await userEvent.clear(cancelDate);
    await userEvent.type(cancelDate, daysOut(30));
    expect(await screen.findByText(/Stays active until/)).toBeInTheDocument();
  });

  it('saves a cancellation with its end date', async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText('Name'), 'Hulu');
    await userEvent.type(screen.getByLabelText('Amount'), '10');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'canceled');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions', expect.objectContaining({ status: 'canceled', end_date: todayStr() })));
  });

  it('treats a scheduled end date as a cancellation intent', async () => {
    renderEditor(sub({ status: 'active', end_date: daysOut(10) }));
    expect(screen.getByLabelText('Status')).toHaveValue('canceled');
    expect(screen.getByLabelText('Cancellation Date')).toHaveValue(daysOut(10));
  });

  it('deletes a subscription after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderEditor(sub());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/subscriptions/1'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('keeps the subscription when the delete is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderEditor(sub());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('reports a delete failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.del as any).mockRejectedValue(new Error('del boom'));
    renderEditor(sub());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('del boom')).toBeInTheDocument();
  });

  it('reports a save failure', async () => {
    (api.post as any).mockRejectedValue(new Error('save boom'));
    renderEditor();
    await userEvent.type(screen.getByLabelText('Name'), 'Hulu');
    await userEvent.type(screen.getByLabelText('Amount'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('save boom')).toBeInTheDocument();
  });

  it('offers no delete button for a new subscription', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('names the managed category after the subscription', async () => {
    renderEditor();
    expect(screen.getByText(/auto-managed “Subscriptions” category/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Hulu');
    expect(screen.getByText(/auto-managed “Hulu” category/)).toBeInTheDocument();
  });

  it('closes without saving', async () => {
    renderEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
