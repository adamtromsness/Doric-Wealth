import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AccountDetail from './AccountDetail';

const navigateMock = vi.fn();
let routeId = '5';
let routeSearch = '';
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ accountId: routeId }),
    useLocation: () => ({ pathname: `/accounts/${routeId}`, search: routeSearch, state: null, hash: '', key: 'k' }),
  };
});

let activeBook: any = { id: 3, name: 'Household', role: 'owner' };
vi.mock('../auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return { ...actual, useAuth: () => ({ ready: true, user: { id: 1, email: 'a@b.c' }, books: [], activeBook }) };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

// These all have dedicated tests; here they only need to prove this page mounted
// them with the right wiring.
vi.mock('./transactions/TxnEditor', () => ({
  TxnEditor: (p: any) => (
    <div data-testid="txn-editor">
      <span>editor:{p.txn ? `edit-${p.txn.id}` : `add-${p.initialAccountId ?? '-'}`}</span>
      <button onClick={p.onClose}>Editor Close</button>
      <button onClick={p.onSaved}>Editor Save</button>
    </div>
  ),
}));
vi.mock('../components/SnapshotTab', () => ({
  SnapshotTab: (p: any) => (
    <div data-testid="snapshot-tab">
      <span>snaps:{p.items.length}</span>
      <span>valueLabel:{p.valueLabel}</span>
      <span>hint:{p.hint}</span>
      <div>{p.emptyText}</div>
      <button onClick={() => p.onAdd('2026-09-01', 42)}>Stub Add Snapshot</button>
      <button onClick={() => p.onDelete(p.items[0]?.id ?? 0)}>Stub Delete Snapshot</button>
    </div>
  ),
}));
vi.mock('../components/EntityDocuments', () => ({
  EntityDocuments: (p: any) => <div data-testid="documents">docs:{p.basePath}</div>,
}));
vi.mock('../components/EntityBeneficiaries', () => ({
  EntityBeneficiaries: (p: any) => <div data-testid="beneficiaries">bene:{p.basePath}</div>,
}));

// ── fixtures ───────────────────────────────────────────────────────────────
const account = (over: Partial<any> = {}): any => ({
  id: 5, name: 'Everyday Checking', type: 'checking', institution: 'Chase',
  is_liability: false, posted_balance: 1500, pending_balance: 1500,
  opening_balance: 1000, opening_date: '2026-01-01', account_number: '1234',
  interest_rate: null, credit_limit: null, due_day: null, username: null,
  beneficiaries: null, opened_date: '2026-01-01', login_url: null, website_url: null,
  phone: null, notes: null, owner: null, owner_user_id: null, ownership_type: 'individual',
  has_beneficiaries: false, is_retirement: false, is_card: false, is_loan: false,
  retirement_plan_kind: null, retirement_custodian: null, retirement_employer: null,
  retirement_contribution_ytd: null, retirement_employer_match: null,
  retirement_vesting_pct: null, retirement_tax_treatment: null, retirement_rmd_applicable: null,
  card_statement_day: null, card_min_payment: null, card_rewards_program: null,
  card_points_balance: null, card_annual_fee: null,
  loan_original_principal: null, loan_term_months: null, loan_payment_amount: null,
  loan_payment_frequency: null, loan_origination_date: null, loan_payoff_date: null,
  loan_escrow_amount: null, loan_lien_holder: null,
  archived_at: null, closed_at: null, close_reason: null, status: 'active',
  auto_synced: false, sync_provider: null, ...over,
});

const txn = (over: Partial<any> = {}): any => ({
  id: 1, account_id: 5, category_id: null, transfer_account_id: null,
  txn_date: '2026-08-04', posted_date: '2026-08-05', amount: 25.5,
  principal_amount: null, interest_category_id: null, direction: 'expense',
  merchant: 'Kroger', description: null, purchaser: null, channel: null, source: null,
  category_name: null, account_name: 'Everyday Checking', transfer_account_name: null,
  has_receipt: false, tags: [], splits: [], has_splits: false, ...over,
});

const categories = [
  { id: 100, name: 'Food', kind: 'expense', parent_id: null, has_children: true, sort_order: 1 },
  { id: 101, name: 'Groceries', kind: 'expense', parent_id: 100, has_children: false, sort_order: 1 },
];

interface Opts {
  account?: any; acctError?: string; snaps?: any[]; holdings?: any[];
  txns?: any; tabTxns?: any; members?: any[];
}

const setup = (o: Opts = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/accounts/5') {
      return o.acctError ? Promise.reject(new Error(o.acctError)) : Promise.resolve(o.account ?? account());
    }
    if (path === '/accounts/5/balances') return Promise.resolve(o.snaps ?? []);
    if (path === '/accounts/5/holdings') return Promise.resolve(o.holdings ?? []);
    if (path.startsWith('/transactions?account_id=5&limit=')) {
      return Promise.resolve(o.txns ?? { pending: [], pendingTotal: 0, posted: [], total: 0 });
    }
    if (path.startsWith('/transactions?')) {
      return Promise.resolve(o.tabTxns ?? { pending: [], pendingTotal: 0, posted: [], total: 0 });
    }
    if (path === '/transactions/merchants') return Promise.resolve(['Kroger']);
    if (path === '/categories') return Promise.resolve(categories);
    if (path === '/accounts') return Promise.resolve([account()]);
    if (path === '/vehicles') return Promise.resolve([{ id: 20, name: 'Truck' }]);
    if (path === '/properties') return Promise.resolve([{ id: 30, name: 'Home' }]);
    if (path === '/tags') return Promise.resolve([{ id: 50, name: 'Vacation', archived: false }, { id: 51, name: 'Old', archived: true }]);
    if (path === '/subscriptions') return Promise.resolve([]);
    if (path === '/books/3/members') return Promise.resolve(o.members ?? [{ id: 7, name: 'Ada', email: 'ada@example.com' }]);
    return Promise.resolve([]);
  });
  (api.post as any).mockResolvedValue({ id: 9 });
  (api.put as any).mockResolvedValue(account());
  (api.del as any).mockResolvedValue({});
};

const renderPage = () => render(<MemoryRouter><AccountDetail /></MemoryRouter>);
const openTab = async (name: string) => userEvent.click(screen.getByRole('button', { name }));

describe('AccountDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = '5';
    routeSearch = '';
    activeBook = { id: 3, name: 'Household', role: 'owner' };
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows a loader, then the header and overview summary', async () => {
    setup({ snaps: [{ id: 1, as_of: '2026-07-01', balance: 1400 }] });
    renderPage();
    expect(await screen.findByRole('heading', { name: /Everyday Checking/ })).toBeInTheDocument();
    expect(screen.getByText('Chase · Checking · Cash & Banking')).toBeInTheDocument();
    expect(screen.getByText('$1,500.00')).toBeInTheDocument();
    expect(screen.getByText('Account treatment')).toBeInTheDocument();
    expect(screen.getByText('Asset')).toBeInTheDocument();
    // The chart axis repeats the date, so read it from its own summary row.
    const snapRow = screen.getByText('Last snapshot').closest('.detail-row') as HTMLElement;
    expect(within(snapRow).getByText('Jul 1, 2026')).toBeInTheDocument();
  });

  it('reports an invalid id without calling the API', async () => {
    routeId = 'abc';
    renderPage();
    expect(await screen.findByText('Invalid account.')).toBeInTheDocument();
    const paths = (api.get as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(paths.some((p: string) => p.startsWith('/accounts/'))).toBe(false);
    expect(paths.some((p: string) => p.includes('NaN'))).toBe(false);
  });

  it('surfaces a load error in place of the page', async () => {
    setup({ acctError: 'no such account' });
    renderPage();
    expect(await screen.findByText('no such account')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('marks a liability account as money owed', async () => {
    setup({ account: account({ is_liability: true, type: 'credit_card', posted_balance: 900, credit_limit: 3000, due_day: 12 }) });
    renderPage();
    expect(await screen.findByText('Liability')).toBeInTheDocument();
    expect(screen.getByText('Credit limit')).toBeInTheDocument();
    expect(screen.getByText('$3,000.00')).toBeInTheDocument();
    expect(screen.getByText('Available credit')).toBeInTheDocument();
    expect(screen.getByText('$2,100.00')).toBeInTheDocument();
    expect(screen.getByText('Utilization')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByText('Payment due day')).toBeInTheDocument();
    expect(screen.getByText('12th')).toBeInTheDocument();
  });

  it('shows loan facts for a loan account', async () => {
    setup({ account: account({ is_liability: true, type: 'loan', interest_rate: 4.25, due_day: 1 }) });
    renderPage();
    expect(await screen.findByText('Interest rate / APR')).toBeInTheDocument();
    expect(screen.getByText('4.25%')).toBeInTheDocument();
    expect(screen.getByText('1st')).toBeInTheDocument();
  });

  it('shows a pending balance only when it differs from posted', async () => {
    setup({ account: account({ pending_balance: 1450 }) });
    renderPage();
    expect(await screen.findByText('Pending balance')).toBeInTheDocument();
    expect(screen.getByText('$1,450.00')).toBeInTheDocument();
  });

  it('tags a closed, archived or scheduled account', async () => {
    setup({ account: account({ status: 'closed', closed_at: '2026-06-01' }) });
    renderPage();
    expect(await screen.findByText('Closed')).toBeInTheDocument();
  });

  it('tags an account scheduled to close', async () => {
    setup({ account: account({ status: 'active', closed_at: '2026-12-01' }) });
    renderPage();
    expect(await screen.findByText('Closes Dec 1, 2026')).toBeInTheDocument();
  });

  it('tags an archived account', async () => {
    setup({ account: account({ archived_at: '2026-05-01' }) });
    renderPage();
    expect(await screen.findByText('Archived')).toBeInTheDocument();
  });

  it('flags an auto-synced account with its provider', async () => {
    setup({ account: account({ auto_synced: true, sync_provider: 'simplefin' }) });
    renderPage();
    expect(await screen.findByText(/Auto-synced · SimpleFIN/)).toBeInTheDocument();
  });

  it('names a non-SimpleFIN sync provider', async () => {
    setup({ account: account({ auto_synced: true, sync_provider: 'plaid' }) });
    renderPage();
    expect(await screen.findByText(/Auto-synced · plaid/)).toBeInTheDocument();
  });

  // ── Overview: chart + recent transactions ────────────────────────────────
  it('draws the balance chart once there are two points', async () => {
    setup({ snaps: [{ id: 1, as_of: '2026-07-01', balance: 1400 }] });
    renderPage();
    await screen.findByText('Balance over time');
    expect(screen.queryByText(/Balance history will appear/)).toBeNull();
  });

  it('explains an empty balance chart', async () => {
    setup({ account: account({ opening_balance: null, opening_date: null }) });
    renderPage();
    expect(await screen.findByText(/Balance history will appear after more snapshots/)).toBeInTheDocument();
  });

  it('lists recent transactions and jumps to the full tab', async () => {
    setup({ txns: { pending: [txn({ id: 2, posted_date: null, txn_date: '2026-08-09', merchant: 'Pending Co' })], pendingTotal: 1, posted: [txn()], total: 1 } });
    renderPage();
    expect(await screen.findByText('Pending Co')).toBeInTheDocument();
    expect(screen.getByText('Kroger')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View all' }));
    expect(screen.getByText('New transactions are added to this account.')).toBeInTheDocument();
  });

  it('opens the editor from a recent transaction once lookups are ready', async () => {
    setup({ txns: { pending: [], pendingTotal: 0, posted: [txn({ id: 77 })], total: 1 } });
    renderPage();
    const row = await screen.findByText('Kroger');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/transactions/merchants'));
    await userEvent.click(row);
    expect(await screen.findByText('editor:edit-77')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Save' }));
    await waitFor(() => expect(screen.queryByTestId('txn-editor')).toBeNull());
  });
});

describe('AccountDetail tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = '5';
    routeSearch = '';
    activeBook = { id: 3, name: 'Household', role: 'owner' };
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  // ── Balance (snapshots) tab ──────────────────────────────────────────────
  it('passes snapshots to the balance tab and adds one', async () => {
    setup({ snaps: [{ id: 11, as_of: '2026-07-01', balance: 1400, auto_imported: true }] });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Balance');
    expect(screen.getByText('snaps:1')).toBeInTheDocument();
    expect(screen.getByText('valueLabel:Balance')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stub Add Snapshot' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts/5/balances', { as_of: '2026-09-01', balance: 42 }));
  });

  it('deletes a snapshot', async () => {
    setup({ snaps: [{ id: 11, as_of: '2026-07-01', balance: 1400 }] });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Balance');
    await userEvent.click(screen.getByRole('button', { name: 'Stub Delete Snapshot' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/accounts/5/balances/11'));
  });

  it('reports a snapshot delete failure', async () => {
    setup({ snaps: [{ id: 11, as_of: '2026-07-01', balance: 1400 }] });
    (api.del as any).mockRejectedValue(new Error('del snap boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Balance');
    await userEvent.click(screen.getByRole('button', { name: 'Stub Delete Snapshot' }));
    expect(await screen.findByText('del snap boom')).toBeInTheDocument();
  });

  it('explains the opening-balance anchor when there are no snapshots', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Balance');
    expect(screen.getByText(/opening balance of \$1,000\.00/)).toBeInTheDocument();
  });

  it('labels the balance tab for a liability', async () => {
    setup({ account: account({ is_liability: true, type: 'credit_card' }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Balance');
    expect(screen.getByText('valueLabel:Balance Owed')).toBeInTheDocument();
    expect(screen.getByText(/enter the amount owed as a positive number/)).toBeInTheDocument();
  });

  // ── Holdings tab ─────────────────────────────────────────────────────────
  it('hides the holdings tab when there are none', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    expect(screen.queryByRole('button', { name: 'Holdings' })).toBeNull();
  });

  it('shows holdings with weights and a total', async () => {
    setup({
      holdings: [
        { id: 1, symbol: 'VTI', description: 'Total Market', shares: 10, market_value: 750, cost_basis: 600, currency: 'USD', as_of: '2026-08-01' },
        { id: 2, symbol: null, description: null, shares: null, market_value: 250, cost_basis: null, currency: null, as_of: null },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Holdings');
    expect(screen.getByText('Holdings · 2')).toBeInTheDocument();
    expect(screen.getByText('VTI')).toBeInTheDocument();
    expect(screen.getByText('Total Market')).toBeInTheDocument();
    expect(screen.getByText('75.0%')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();
    expect(screen.getByText(/As of Aug 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
  });

  // ── Transactions tab ─────────────────────────────────────────────────────
  it('shows an empty transactions tab', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    expect(screen.getByText('No transactions for this account yet.')).toBeInTheDocument();
  });

  it('lists pending and posted groups in the transactions tab', async () => {
    setup({
      tabTxns: {
        pending: [txn({ id: 2, posted_date: null, merchant: 'Pending Co' })], pendingTotal: 1,
        posted: [txn({ id: 3, merchant: 'Posted Co' })], total: 1,
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    expect(await screen.findByText('Pending Co')).toBeInTheDocument();
    expect(screen.getByText('Posted Co')).toBeInTheDocument();
    expect(screen.getByText('Pending · 1 awaiting posting')).toBeInTheDocument();
    expect(screen.getByText('Posted', { selector: '.label' })).toBeInTheDocument();
  });

  it('titles the only group Transactions when nothing is pending', async () => {
    setup({ tabTxns: { pending: [], pendingTotal: 0, posted: [txn()], total: 1 } });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    expect(await screen.findByText('Transactions', { selector: '.label' })).toBeInTheDocument();
  });

  it('adds a transaction scoped to this account', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Transaction' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Add Transaction' }));
    expect(screen.getByText('editor:add-5')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Close' }));
    expect(screen.queryByTestId('txn-editor')).toBeNull();
  });

  it('pages the posted list in the transactions tab', async () => {
    setup({ tabTxns: { pending: [], pendingTotal: 0, posted: [txn()], total: 120 } });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    await waitFor(() => expect(screen.getAllByText('Showing 1–1 of 120').length).toBe(2));
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => {
      const paths = (api.get as any).mock.calls.map((c: any[]) => c[0] as string);
      expect(paths.some((p: string) => p.includes('postedOffset=50'))).toBe(true);
    });
  });

  it('pages the pending list in the transactions tab', async () => {
    setup({ tabTxns: { pending: [txn({ posted_date: null })], pendingTotal: 80, posted: [], total: 0 } });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    await waitFor(() => expect(screen.getAllByText('Showing 1–1 of 80').length).toBe(2));
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => {
      const paths = (api.get as any).mock.calls.map((c: any[]) => c[0] as string);
      expect(paths.some((p: string) => p.includes('pendingOffset=50'))).toBe(true);
    });
  });

  it('reports when a filter excludes everything', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Transactions');
    await userEvent.type(screen.getByPlaceholderText(/Search/i), 'nothing-matches');
    expect(await screen.findByText('No transactions match these filters.')).toBeInTheDocument();
  });

  // ── Capability tabs ──────────────────────────────────────────────────────
  it('hides capability tabs that are switched off', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    for (const name of ['Retirement', 'Card', 'Loan', 'Beneficiaries']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('edits and saves retirement details', async () => {
    setup({ account: account({ is_retirement: true, retirement_custodian: 'Fidelity', retirement_rmd_applicable: false }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Retirement');
    expect(screen.getByText('Retirement Details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    await userEvent.clear(screen.getByDisplayValue('Fidelity'));
    await userEvent.type(screen.getByLabelText('Custodian'), 'Vanguard');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/accounts/5', expect.objectContaining({ retirement_custodian: 'Vanguard' })));
  });

  it('saves card details, coercing amounts and numbers', async () => {
    setup({ account: account({ is_liability: true, type: 'credit_card', is_card: true }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Card');
    await userEvent.type(screen.getByLabelText('Statement Close Day'), '15');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/accounts/5', expect.objectContaining({ card_statement_day: 15, credit_limit: null })));
  });

  it('saves loan details including a select and a date', async () => {
    setup({ account: account({ is_liability: true, type: 'loan', is_loan: true }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Loan');
    await userEvent.selectOptions(screen.getByLabelText('Payment Frequency'), 'weekly');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/accounts/5', expect.objectContaining({ loan_payment_frequency: 'weekly' })));
  });

  it('toggles a capability checkbox and reports a save failure', async () => {
    setup({ account: account({ is_retirement: true }) });
    (api.put as any).mockRejectedValue(new Error('cap boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Retirement');
    await userEvent.click(screen.getByLabelText(/Required Minimum Distributions apply/));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('cap boom')).toBeInTheDocument();
  });

  it('mounts the beneficiaries and documents tabs against this account', async () => {
    setup({ account: account({ has_beneficiaries: true }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Beneficiaries');
    expect(screen.getByText('bene:/accounts/5')).toBeInTheDocument();
    await openTab('Documents');
    expect(screen.getByText('docs:/accounts/5')).toBeInTheDocument();
  });
});

describe('AccountDetail details tab and lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = '5';
    routeSearch = '';
    activeBook = { id: 3, name: 'Household', role: 'owner' };
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('edits and saves the account info form', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    expect(screen.getByText('Account details')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Institution'), ' Bank');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/accounts/5', expect.objectContaining({ institution: 'Chase Bank' })));
  });

  it('refuses to save without a name', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.clear(screen.getByLabelText('Account Name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('surfaces a save failure from the info form', async () => {
    (api.put as any).mockRejectedValue(new Error('save boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.type(screen.getByLabelText('Notes'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('save boom')).toBeInTheDocument();
  });

  it('links an owner from the book members list', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.selectOptions(screen.getByLabelText('Linked Member'), '7');
    expect(screen.getByLabelText('Owner Name')).toHaveValue('Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/accounts/5', expect.objectContaining({ owner: 'Ada', owner_user_id: 7 })));
  });

  it('falls back to a member email when they have no name', async () => {
    setup({ members: [{ id: 8, name: null, email: 'noname@example.com' }] });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.selectOptions(screen.getByLabelText('Linked Member'), '8');
    expect(screen.getByLabelText('Owner Name')).toHaveValue('noname@example.com');
  });

  it('turns on the capability a chosen type needs, revealing its tab', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    expect(screen.queryByRole('button', { name: 'Retirement' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Account Type'), 'retirement');
    // The tab appears as soon as the toggle flips, before saving.
    expect(await screen.findByRole('button', { name: 'Retirement' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beneficiaries' })).toBeInTheDocument();
  });

  it('falls back to the details tab when a capability is switched off', async () => {
    setup({ account: account({ is_retirement: true }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Retirement');
    expect(screen.getByText('Retirement Details')).toBeInTheDocument();
    await openTab('Details');
    await userEvent.click(screen.getByLabelText(/Track retirement details/));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retirement' })).toBeNull());
  });

  it('formats a phone number on blur and enables the open buttons for real URLs', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    const phone = screen.getByLabelText('Phone');
    await userEvent.type(phone, '8005550100');
    await userEvent.tab();
    expect(phone).toHaveValue('(800) 555-0100');

    const openButtons = screen.getAllByRole('button', { name: 'Open' });
    expect(openButtons[0]).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Web Address'), 'chase.com');
    expect(screen.getAllByRole('button', { name: 'Open' })[0]).toBeEnabled();
  });

  it('opens a web address in a new tab', async () => {
    setup({ account: account({ website_url: 'chase.com' }) });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]);
    expect(open).toHaveBeenCalledWith('https://chase.com', '_blank', 'noopener');
  });

  // The Details tab is the editable form; the Overview tab holds the read-only facts.
  it('seeds the form from every optional field that is set', async () => {
    setup({
      account: account({
        owner: 'Ada', ownership_type: 'joint', website_url: 'chase.com', phone: '(800) 555-0100',
        login_url: 'chase.com/login', username: 'ada', interest_rate: 1.5,
        notes: 'a note', opened_date: '2026-01-02',
      }),
    });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    expect(screen.getByLabelText('Owner Name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Ownership Type')).toHaveValue('joint');
    expect(screen.getByLabelText('Web Address')).toHaveValue('chase.com');
    expect(screen.getByLabelText('Login URL')).toHaveValue('chase.com/login');
    expect(screen.getByLabelText('Login ID')).toHaveValue('ada');
    expect(screen.getByLabelText('Phone')).toHaveValue('(800) 555-0100');
    expect(screen.getByLabelText('Interest Rate / APR (%)')).toHaveValue('1.5');
    expect(screen.getByLabelText('Notes')).toHaveValue('a note');
    expect(screen.getByLabelText('Account Opened (at the Bank)')).toHaveValue('2026-01-02');
  });

  it('leaves the open buttons disabled for an unparseable url', async () => {
    setup({ account: account({ website_url: 'not a url', login_url: 'also bad' }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    expect(screen.getByLabelText('Web Address')).toHaveValue('not a url');
    for (const b of screen.getAllByRole('button', { name: 'Open' })) expect(b).toBeDisabled();
  });

  // ── Close / reopen / delete ──────────────────────────────────────────────
  it('closes an account through the inline form', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Close Account' }));
    await userEvent.type(screen.getByLabelText('Reason (Optional)'), 'switched banks');
    await userEvent.click(screen.getAllByRole('button', { name: 'Close Account' })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts/5/close',
      expect.objectContaining({ closed: true, close_reason: 'switched banks' })));
  });

  it('cancels the close form', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Close Account' }));
    expect(screen.getByLabelText('Close Date')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Close Date')).toBeNull();
  });

  it('reports a close failure', async () => {
    (api.post as any).mockRejectedValue(new Error('close boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Close Account' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Close Account' })[0]);
    expect(await screen.findByText('close boom')).toBeInTheDocument();
  });

  it('reopens a closed account', async () => {
    setup({ account: account({ status: 'closed', closed_at: '2026-06-01', close_reason: 'switched banks' }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    expect(screen.getByText(/Closed as of Jun 1, 2026 — switched banks/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen Account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts/5/close', { closed: false }));
  });

  it('describes a scheduled close', async () => {
    setup({ account: account({ status: 'active', closed_at: '2026-12-01', close_reason: 'moving' }) });
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    expect(screen.getByText(/Scheduled to close on Dec 1, 2026 — moving/)).toBeInTheDocument();
  });

  it('deletes the account after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/accounts/5'));
    expect(navigateMock).toHaveBeenCalledWith('/accounts');
  });

  it('keeps the account when the delete is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('reports a delete failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.del as any).mockRejectedValue(new Error('delete boom'));
    renderPage();
    await screen.findByRole('heading', { name: /Everyday Checking/ });
    await openTab('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('delete boom')).toBeInTheDocument();
  });
});

describe('AccountDetail new-account mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeId = 'new';
    routeSearch = '';
    activeBook = { id: 3, name: 'Household', role: 'owner' };
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders an empty add-account form and creates the account', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add account' })).toBeInTheDocument();
    expect(screen.getByText('New account')).toBeInTheDocument();
    // Nothing is loaded in new mode.
    const paths = (api.get as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(paths.some((p: string) => p.startsWith('/accounts/'))).toBe(false);

    await userEvent.type(screen.getByLabelText('Account Name'), 'New Savings');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts', expect.objectContaining({ name: 'New Savings', type: 'checking' })));
    expect(navigateMock).toHaveBeenCalledWith('/accounts/9');
  });

  it('defaults to a liability for the liability treatment', async () => {
    routeSearch = '?treatment=liability';
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add liability' })).toBeInTheDocument();
    expect(screen.getByText('New liability')).toBeInTheDocument();
    // The treatment scopes the type list and hides the treatment checkbox.
    expect(screen.queryByLabelText(/This is a liability account/)).toBeNull();
    await userEvent.type(screen.getByLabelText('Account Name'), 'New Card');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts', expect.objectContaining({ is_liability: true, type: 'credit_card' })));
  });

  it('accepts the legacy liability shortcut', async () => {
    routeSearch = '?liability=1';
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add liability' })).toBeInTheDocument();
  });

  it('scopes the type list for the asset treatment', async () => {
    routeSearch = '?treatment=asset';
    renderPage();
    await screen.findByRole('heading', { name: 'Add account' });
    expect(screen.queryByLabelText(/This is a liability account/)).toBeNull();
    const types = within(screen.getByLabelText('Account Type')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(types).toContain('checking');
    expect(types).not.toContain('credit_card');
  });

  it('marks a new account as a liability from the checkbox', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Add account' });
    await userEvent.type(screen.getByLabelText('Account Name'), 'Manual Liability');
    await userEvent.click(screen.getByLabelText(/This is a liability account/));
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounts', expect.objectContaining({ is_liability: true })));
  });
});
