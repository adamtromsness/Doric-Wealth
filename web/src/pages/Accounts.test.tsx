import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Accounts, { AccountEditor, getAccountDisplayGroup, accountGroupLabel } from './Accounts';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});
import { api } from '../api';

const navMock = vi.fn();
let locationState: any = null;
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navMock,
    useLocation: () => ({ state: locationState, pathname: '/accounts', search: '' }),
  };
});

const acct = (o: Partial<any>): any => ({
  id: 0, name: '', type: 'checking', institution: null, is_liability: false,
  posted_balance: 0, pending_balance: 0, opening_balance: null, opening_date: null,
  account_number: null, interest_rate: null, credit_limit: null, due_day: null,
  username: null, beneficiaries: null, opened_date: null, login_url: null, website_url: null,
  phone: null, notes: null, owner: null, owner_user_id: null, ownership_type: null,
  has_beneficiaries: false, is_retirement: false, is_card: false, is_loan: false,
  archived_at: null, closed_at: null, close_reason: null, status: 'active', ...o,
});

const ACCOUNTS = [
  acct({ id: 1, name: 'Everyday Checking', type: 'checking', institution: 'Chase', posted_balance: 5000, pending_balance: 4800, account_number: '123456789', due_day: 1, beneficiaries: 'Jane', notes: 'main', login_url: 'https://chase.com' }),
  acct({ id: 2, name: 'Brokerage', type: 'investment', posted_balance: 20000, pending_balance: 20000, interest_rate: 3.5 }),
  acct({ id: 3, name: 'Visa Card', type: 'credit_card', is_liability: true, posted_balance: 1500, pending_balance: 1500, credit_limit: 10000, due_day: 15 }),
  acct({ id: 4, name: 'Home Loan', type: 'mortgage', is_liability: true, posted_balance: 250000, pending_balance: 250000 }),
  acct({ id: 5, name: 'Closed Savings', type: 'savings', posted_balance: 0, pending_balance: 0, status: 'closed', closed_at: '2026-01-01', close_reason: 'switched banks' }),
];

const fixtures: Record<string, any> = { '/accounts': ACCOUNTS };
const getImpl = (over?: Record<string, any>) => (p: string) => Promise.resolve((over ?? fixtures)[p] ?? {});

describe('Accounts page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locationState = null;
    localStorage.clear();
    (api.get as any).mockImplementation((p: string) => {
      if (p.match(/^\/accounts\/\d+\/balances/)) return Promise.resolve([]);
      return getImpl()(p);
    });
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
  });

  const renderPage = (props?: any) => render(<MemoryRouter><Accounts {...props} /></MemoryRouter>);

  it('exposes group helpers', () => {
    expect(getAccountDisplayGroup({ type: 'checking', is_liability: false })).toBe('cash');
    expect(getAccountDisplayGroup({ type: 'credit_card', is_liability: true })).toBe('credit');
    expect(getAccountDisplayGroup({ type: 'weird', is_liability: true })).toBe('loans');
    expect(getAccountDisplayGroup({ type: 'weird', is_liability: false })).toBe('assets');
    expect(accountGroupLabel({ type: 'checking', is_liability: false })).toBe('Cash & Banking');
  });

  // The bar chart's Y axis also renders account names, so account labels can appear
  // more than once. Grab the card-title occurrence.
  const cardTitle = (name: string) =>
    screen.getAllByText(name).map((el) => el.closest('.kindcard')).find(Boolean) as HTMLElement | undefined;

  it('renders totals, grouped lists, and charts', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Everyday Checking').length).toBeGreaterThan(0));
    expect(screen.getByText('Assets')).toBeInTheDocument();
    expect(screen.getByText('Cash & Banking')).toBeInTheDocument();
    expect(screen.getByText('Investments')).toBeInTheDocument();
    expect(screen.getByText('Credit Cards')).toBeInTheDocument();
    expect(screen.getByText('Mortgages')).toBeInTheDocument();
    // Chart headings.
    expect(screen.getByText('Assets by type')).toBeInTheDocument();
    expect(screen.getByText('Liabilities by type')).toBeInTheDocument();
  });

  it('shows an error when accounts fail to load', async () => {
    (api.get as any).mockImplementation((p: string) =>
      p === '/accounts' ? Promise.reject(new Error('nope')) : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
  });

  it('renders the empty state with no accounts', async () => {
    (api.get as any).mockImplementation(getImpl({ '/accounts': [] }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No accounts yet/)).toBeInTheDocument());
  });

  it('navigates to a detail page when a card is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(cardTitle('Everyday Checking')).toBeTruthy());
    await user.click(cardTitle('Everyday Checking')!);
    expect(navMock).toHaveBeenCalledWith('/accounts/1');
  });

  it('navigates via the Add Account button', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(cardTitle('Everyday Checking')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Add Account' }));
    expect(navMock).toHaveBeenCalledWith('/accounts/new');
  });

  it('adds a treatment query param when scoped to assets', async () => {
    const user = userEvent.setup();
    renderPage({ treatment: 'asset' });
    await waitFor(() => expect(screen.getByText('Total Value')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Account' }));
    expect(navMock).toHaveBeenCalledWith('/accounts/new?treatment=asset');
  });

  it('renders liability-view tiles', async () => {
    renderPage({ treatment: 'liability' });
    await waitFor(() => expect(screen.getByText('Total Owed')).toBeInTheDocument());
    expect(screen.getByText('Available Credit')).toBeInTheDocument();
    expect(screen.getByText('Credit Used')).toBeInTheDocument();
  });

  it('toggles the charts visibility and persists', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Assets by type')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Hide Charts' }));
    expect(screen.queryByText('Assets by type')).toBeNull();
    expect(localStorage.getItem('accounts.hideCharts')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Show Charts' }));
    expect(screen.getByText('Assets by type')).toBeInTheDocument();
  });

  it('shows inactive accounts when toggled', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Inactive Accounts/)).toBeInTheDocument());
    expect(screen.queryByText('Closed Savings')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('Closed Savings')).toBeInTheDocument();
    expect(localStorage.getItem('accounts.showInactive')).toBe('1');
  });

  it('opens the bulk-balance modal and saves snapshots', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(cardTitle('Everyday Checking')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Update Balances' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save snapshots' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save snapshots' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts/1/balances', expect.objectContaining({ balance: expect.any(Number) })));
  });

  it('validates the bulk modal when no date is set', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(cardTitle('Everyday Checking')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Update Balances' }));
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save snapshots' }));
    expect(await screen.findByText('Pick a date.')).toBeInTheDocument();
  });

  it('reorders accounts via drag and drop', async () => {
    // Add a second cash account so a reorder has a second slot.
    const cats = [...ACCOUNTS, acct({ id: 6, name: 'Second Checking', type: 'checking', posted_balance: 100 })];
    (api.get as any).mockImplementation((p: string) => {
      if (p.match(/^\/accounts\/\d+\/balances/)) return Promise.resolve([]);
      return p === '/accounts' ? Promise.resolve(cats) : Promise.resolve({});
    });
    renderPage();
    await waitFor(() => expect(cardTitle('Second Checking')).toBeTruthy());
    const firstCard = cardTitle('Everyday Checking')!;
    const secondCard = cardTitle('Second Checking')!;
    const handle = within(firstCard).getByTitle('Drag to reorder');
    fireEvent.dragStart(handle);
    fireEvent.dragOver(secondCard);
    fireEvent.drop(secondCard);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts/reorder', expect.objectContaining({ ids: expect.any(Array) })));
  });

  it('deep-links into the add flow from navigation state', async () => {
    locationState = { add: true, liability: true };
    renderPage();
    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/accounts/new?liability=1', expect.objectContaining({ replace: true })));
  });
});

describe('AccountEditor', () => {
  const existing = acct({ id: 1, name: 'Everyday Checking', type: 'checking', institution: 'Chase', posted_balance: 5000, login_url: 'https://chase.com' });

  const renderEditor = (props?: any) => {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), ...props };
    render(<MemoryRouter><AccountEditor account={existing} {...handlers} /></MemoryRouter>);
    return handlers;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockImplementation((p: string) => {
      if (p.match(/^\/accounts\/\d+\/balances/)) {
        return Promise.resolve([
          { id: 10, as_of: '2026-02-01', balance: 5000 },
          { id: 11, as_of: '2026-01-01', balance: 4000 },
        ]);
      }
      return Promise.resolve({});
    });
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
  });

  it('renders the edit form with existing snapshots', async () => {
    renderEditor();
    expect(await screen.findByText('Edit Account')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Anchor')).toBeInTheDocument());
    expect((screen.getByPlaceholderText('Everyday Checking') as HTMLInputElement).value).toBe('Everyday Checking');
  });

  it('renders the add form for a new account', () => {
    render(<MemoryRouter><AccountEditor account={null} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} onChanged={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Add Account' })).toBeInTheDocument();
    expect(screen.getByText(/Add the account first/)).toBeInTheDocument();
  });

  it('saves edits via PUT', async () => {
    const user = userEvent.setup();
    const h = renderEditor();
    await screen.findByText('Edit Account');
    const nameInput = screen.getByPlaceholderText('Everyday Checking');
    await user.type(nameInput, '!');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/accounts/1', expect.objectContaining({ name: 'Everyday Checking!' })));
    expect(h.onSaved).toHaveBeenCalled();
  });

  it('validates a required name', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText('Edit Account');
    const nameInput = screen.getByPlaceholderText('Everyday Checking');
    await user.clear(nameInput);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });

  it('adds a balance snapshot', async () => {
    const user = userEvent.setup();
    const h = renderEditor();
    await screen.findByText('Edit Account');
    const balInput = screen.getByPlaceholderText('e.g. 9665.00');
    await user.type(balInput, '1234.56');
    await user.click(screen.getByRole('button', { name: 'Add Snapshot' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts/1/balances', expect.objectContaining({ balance: 1234.56 })));
    expect(h.onChanged).toHaveBeenCalled();
  });

  it('deletes a snapshot', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText('Edit Account');
    await waitFor(() => expect(screen.getByText('Anchor')).toBeInTheDocument());
    const delButtons = screen.getAllByTitle('Delete snapshot');
    await user.click(delButtons[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/accounts/1/balances/10'));
  });

  it('deletes the account after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const h = renderEditor();
    await screen.findByText('Edit Account');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/accounts/1'));
    expect(h.onDeleted).toHaveBeenCalled();
  });

  it('shows a warning for a negative liability snapshot balance', async () => {
    const user = userEvent.setup();
    const liab = acct({ id: 2, name: 'Card', type: 'credit_card', is_liability: true });
    render(<MemoryRouter><AccountEditor account={liab} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} onChanged={vi.fn()} /></MemoryRouter>);
    await screen.findByText('Edit Account');
    const balInput = screen.getByPlaceholderText('e.g. 9665.00');
    await user.type(balInput, '-50');
    expect(await screen.findByText(/Heads up: this is a liability/)).toBeInTheDocument();
  });

  it('shows a "View all" snapshot modal when there are many snapshots', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation((p: string) => {
      if (p.match(/^\/accounts\/\d+\/balances/)) {
        return Promise.resolve(Array.from({ length: 12 }, (_, i) => ({ id: i + 1, as_of: `2026-01-${String(i + 1).padStart(2, '0')}`, balance: 1000 + i })));
      }
      return Promise.resolve({});
    });
    renderEditor();
    await screen.findByText('Edit Account');
    await waitFor(() => expect(screen.getByText(/Showing latest 10 of 12/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'View all' }));
    expect(await screen.findByText(/Balance snapshots ·/)).toBeInTheDocument();
  });
});
