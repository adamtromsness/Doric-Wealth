import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Transactions from './Transactions';
import { FILTER_KEY } from './transactions/helpers';
import { DEFAULT_FILTERS } from '../components/txnFilters';

const navigateMock = vi.fn();
let locationState: any = null;
let locationSearch = '';
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ pathname: '/transactions', search: locationSearch, state: locationState, hash: '', key: 'k' }),
  };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

// The editor and the import modals each have their own tests; here they only need
// to prove the page opened them with the right intent.
vi.mock('./transactions/TxnEditor', () => ({
  TxnEditor: (p: any) => (
    <div data-testid="txn-editor">
      <span>editor:{p.txn ? `edit-${p.txn.id}` : p.convertPair ? `convert-${p.convertPair.out_id}-${p.convertPair.in_id}` : p.confirmStaged ? `staged-${p.confirmStaged.id}` : 'add'}</span>
      <span>seed-direction:{p.seed?.direction ?? '-'}</span>
      <span>seed-merchant:{p.seed?.merchant ?? '-'}</span>
      <span>purchasers:{p.purchasers.join(',')}</span>
      <button onClick={p.onClose}>Editor Close</button>
      <button onClick={p.onSaved}>Editor Save</button>
    </div>
  ),
}));
vi.mock('../components/ImportModal', () => ({
  ImportModal: (p: any) => (
    <div data-testid="import-modal">
      <button onClick={p.onClose}>CSV Close</button>
      <button onClick={p.onImported}>CSV Imported</button>
    </div>
  ),
}));
vi.mock('../components/ImportSimpleFinModal', () => ({
  ImportSimpleFinModal: (p: any) => (
    <div data-testid="sf-modal">
      <button onClick={p.onClose}>SF Close</button>
      <button onClick={p.onImported}>SF Imported</button>
    </div>
  ),
}));
vi.mock('../components/SubscriptionSuggestions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/SubscriptionSuggestions')>();
  return {
    ...actual,
    SubscriptionSuggestionDetail: (p: any) => (
      <div data-testid="sug-detail">
        <span>detail:{p.suggestion.merchant}</span>
        <button onClick={p.onClose}>Detail Close</button>
        <button onClick={p.onChanged}>Detail Changed</button>
      </div>
    ),
  };
});

// ── fixtures ───────────────────────────────────────────────────────────────
const categories = [
  { id: 100, name: 'Food', kind: 'expense', parent_id: null, has_children: true, sort_order: 1 },
  { id: 101, name: 'Groceries', kind: 'expense', parent_id: 100, has_children: false, sort_order: 1 },
  { id: 200, name: 'Earnings', kind: 'income', parent_id: null, has_children: true, sort_order: 1 },
  { id: 201, name: 'Salary', kind: 'income', parent_id: 200, has_children: false, sort_order: 1 },
];
const accounts = [
  { id: 1, name: 'Checking', type: 'checking', is_liability: false },
  { id: 2, name: 'Savings', type: 'savings', is_liability: false },
  { id: 3, name: 'Visa', type: 'credit_card', is_liability: true },
];
const vehicles = [{ id: 20, name: 'Truck' }];
const properties = [{ id: 30, name: 'Home' }];
const subscriptions = [{ id: 40, name: 'Netflix', tier: null, status: 'active' }];
const tags = [{ id: 50, name: 'Vacation', archived: false }, { id: 51, name: 'Old', archived: true }];

const txn = (over: Partial<any> = {}): any => ({
  id: 1, account_id: 1, category_id: 101, transfer_account_id: null,
  txn_date: '2026-08-04', posted_date: '2026-08-05', amount: 25.5,
  principal_amount: null, interest_category_id: null, direction: 'expense',
  merchant: 'Kroger', description: 'weekly shop', purchaser: 'Ada', channel: 'in_store',
  source: null, category_name: 'Groceries', account_name: 'Checking',
  transfer_account_name: null, has_receipt: false, tags: [], splits: [], has_splits: false,
  ...over,
});

const staged = (over: Partial<any> = {}): any => ({
  id: 500, batch_id: 9, account_id: 1, category_id: null, txn_date: '2026-08-10',
  amount: 12.34, direction: 'expense', merchant: 'Shell', raw_merchant: 'SHELL OIL 4432',
  description: null, source: 'csv', external_id: null, decision: 'import',
  duplicate_of: null, skip_reason: null, account_name: 'Checking', category_name: null,
  dup_merchant: null, dup_date: null, dup_amount: null, ...over,
});

const suggestion = (over: Partial<any> = {}): any => ({
  merchant: 'Netflix', key: 'netflix', amount: 15.99, billing_cycle: 'monthly',
  count: 4, last_date: '2026-08-01', next_due_date: '2026-09-01', interval_days: 30,
  transactions: [
    { id: 81, date: '2026-08-01', amount: 15.99 },
    { id: 82, date: '2026-07-01', amount: 15.99 },
  ],
  ...over,
});

const postedPair = (over: Partial<any> = {}): any => ({
  key: 'pp-1', amount: 300,
  out: { id: 11, account_id: 1, account_name: 'Checking', date: '2026-08-02', merchant: 'Transfer Out' },
  in: { id: 12, account_id: 2, account_name: 'Savings', date: '2026-08-03', merchant: 'Transfer In' },
  ...over,
});

const stagedPair = (over: Partial<any> = {}): any => ({
  out: { id: 601, account_id: 1, account_name: 'Checking', txn_date: '2026-08-06', amount: 75, direction: 'expense', merchant: 'Move Out', description: null },
  in: { id: 602, account_id: 2, account_name: 'Savings', txn_date: '2026-08-06', amount: 75, direction: 'income', merchant: 'Move In', description: null },
  ...over,
});

interface Opts {
  pending?: any[]; pendingTotal?: number; posted?: any[]; total?: number;
  staged?: any[]; suggestions?: any[]; postedPairs?: any[]; stagedPairs?: any[];
  rules?: any[]; merchants?: string[]; txnError?: string;
}

const setup = (o: Opts = {}) => {
  (api.get as any).mockImplementation((path: string) => {
    if (path.startsWith('/transactions?')) {
      if (o.txnError) return Promise.reject(new Error(o.txnError));
      return Promise.resolve({
        pending: o.pending ?? [], pendingTotal: o.pendingTotal ?? (o.pending?.length ?? 0),
        posted: o.posted ?? [], total: o.total ?? (o.posted?.length ?? 0),
      });
    }
    if (path === '/transactions/merchants') return Promise.resolve(o.merchants ?? ['Kroger']);
    if (path === '/transactions/transfer-suggestions') return Promise.resolve(o.postedPairs ?? []);
    if (path === '/imports/staged/transfer-candidates') return Promise.resolve(o.stagedPairs ?? []);
    if (path === '/imports/transfer-rules') return Promise.resolve(o.rules ?? []);
    if (path === '/imports/staged') return Promise.resolve(o.staged ?? []);
    if (path === '/subscriptions/suggestions') return Promise.resolve(o.suggestions ?? []);
    if (path === '/subscriptions') return Promise.resolve(subscriptions);
    if (path === '/tags') return Promise.resolve(tags);
    if (path === '/categories') return Promise.resolve(categories);
    if (path === '/accounts') return Promise.resolve(accounts);
    if (path === '/vehicles') return Promise.resolve(vehicles);
    if (path === '/properties') return Promise.resolve(properties);
    return Promise.resolve([]);
  });
  (api.post as any).mockResolvedValue({});
  (api.del as any).mockResolvedValue({});
};

const renderPage = () => render(<MemoryRouter><Transactions /></MemoryRouter>);
const lastTxnUrl = () => {
  const calls = (api.get as any).mock.calls.map((c: any[]) => c[0]).filter((p: string) => p.startsWith('/transactions?'));
  return calls[calls.length - 1] as string;
};

describe('Transactions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    locationState = null;
    locationSearch = '';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the header and an empty posted list', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Transactions', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('No transactions match. Add one or clear filters.')).toBeInTheDocument();
    // No review section when there is nothing to review.
    expect(screen.queryByRole('heading', { name: 'Review' })).toBeNull();
  });

  it('renders a posted expense row with its detail columns', async () => {
    setup({ posted: [txn({ has_receipt: true, source: 'simplefin', tags: [{ kind: 'tag', ref_id: 50, name: 'Vacation' }] })], total: 1 });
    renderPage();
    expect(await screen.findByText('Kroger')).toBeInTheDocument();
    expect(screen.getByText('weekly shop')).toBeInTheDocument();
    expect(screen.getByText('In-store')).toBeInTheDocument();
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Vacation')).toBeInTheDocument();
    expect(screen.getByText('−$25.50')).toBeInTheDocument();
    expect(screen.getByText('🧾')).toBeInTheDocument();
    expect(screen.getByTitle('Auto-imported from a linked bank')).toBeInTheDocument();
    expect(screen.getByText('1 total')).toBeInTheDocument();
  });

  it('renders income with a positive amount and a dash for missing fields', async () => {
    setup({ posted: [txn({ id: 2, direction: 'income', amount: 1000, category_name: 'Salary', merchant: null, description: null, purchaser: null, channel: null })], total: 1 });
    renderPage();
    expect(await screen.findByText('+$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('renders a split transaction as a split tag', async () => {
    setup({
      posted: [txn({
        has_splits: true,
        splits: [
          { id: 1, amount: 10, category_id: 101, tags: [{ kind: 'vehicle', ref_id: 20, name: 'Truck' }] },
          { id: 2, amount: 15.5, category_id: 101, tags: [{ kind: 'vehicle', ref_id: 20, name: 'Truck' }] },
        ],
      })],
      total: 1,
    });
    renderPage();
    expect(await screen.findByText('Split · 2')).toBeInTheDocument();
    // Duplicate tags across splits collapse to one chip.
    expect(screen.getAllByText('Truck')).toHaveLength(1);
  });

  it('renders a transfer with its principal and cost breakdown', async () => {
    setup({
      posted: [txn({
        direction: 'transfer', amount: 500, principal_amount: 450,
        transfer_account_name: 'Visa', category_name: null,
      })],
      total: 1,
    });
    renderPage();
    expect(await screen.findByText('Transfer')).toBeInTheDocument();
    expect(screen.getByText('→ Visa')).toBeInTheDocument();
    expect(screen.getByText(/principal \$450\.00 · costs \$50\.00/)).toBeInTheDocument();
  });

  it('omits the principal line for a transfer whose costs round to zero', async () => {
    setup({ posted: [txn({ direction: 'transfer', amount: 500, principal_amount: 500, category_name: null })], total: 1 });
    renderPage();
    expect(await screen.findByText('Transfer')).toBeInTheDocument();
    expect(screen.queryByText(/principal/)).toBeNull();
  });

  it('sums principal across splits on a transfer', async () => {
    setup({
      posted: [txn({
        direction: 'transfer', amount: 500, category_name: null, has_splits: true,
        splits: [
          { id: 1, amount: 300, category_id: null, is_principal: true, tags: [] },
          { id: 2, amount: 100, category_id: null, is_principal: true, tags: [] },
          { id: 3, amount: 100, category_id: null, tags: [] },
        ],
      })],
      total: 1,
    });
    renderPage();
    expect(await screen.findByText(/principal \$400\.00 · costs \$100\.00/)).toBeInTheDocument();
  });

  it('shows the pending section and marks a row posted', async () => {
    setup({ pending: [txn({ id: 7, posted_date: null, merchant: 'Pending Co' })], pendingTotal: 1 });
    renderPage();
    expect(await screen.findByText('Pending Co')).toBeInTheDocument();
    expect(screen.getByText('1 awaiting posting')).toBeInTheDocument();
    // Posted list reports the pending-aware empty copy.
    expect(screen.getByText('No posted transactions match.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Posted' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/transactions/7/post'));
  });

  it('surfaces a mark-posted failure', async () => {
    setup({ pending: [txn({ id: 7, posted_date: null })], pendingTotal: 1 });
    (api.post as any).mockRejectedValue(new Error('post boom'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark Posted' }));
    expect(await screen.findByText('post boom')).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    setup({ txnError: 'list boom' });
    renderPage();
    expect(await screen.findByText('list boom')).toBeInTheDocument();
  });

  it('opens the editor to add, then closes it', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add Transaction' }));
    expect(screen.getByText('editor:add')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Close' }));
    expect(screen.queryByTestId('txn-editor')).toBeNull();
  });

  it('opens the editor on a row click and reloads after save', async () => {
    setup({ posted: [txn({ id: 42 })], total: 1 });
    renderPage();
    await userEvent.click(await screen.findByText('Kroger'));
    expect(screen.getByText('editor:edit-42')).toBeInTheDocument();
    // Purchasers are derived from the loaded rows.
    expect(screen.getByText('purchasers:Ada')).toBeInTheDocument();
    const before = (api.get as any).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Editor Save' }));
    await waitFor(() => expect((api.get as any).mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByTestId('txn-editor')).toBeNull();
  });

  it('opens and closes the CSV import modal', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Import CSV' }));
    expect(screen.getByTestId('import-modal')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'CSV Imported' }));
    await waitFor(() => expect(screen.queryByTestId('import-modal')).toBeNull());
    expect(api.get).toHaveBeenCalledWith('/imports/staged');
  });

  it('opens the SimpleFIN import modal and reloads the queue', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Import SimpleFIN' }));
    await userEvent.click(screen.getByRole('button', { name: 'SF Imported' }));
    // This modal stays open after an import.
    expect(screen.getByTestId('sf-modal')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'SF Close' }));
    expect(screen.queryByTestId('sf-modal')).toBeNull();
  });
});

describe('Transactions review section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    locationState = null;
    locationSearch = '';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  // ── Possible Transfers (already-posted pairs) ────────────────────────────
  it('lists posted transfer candidates and explains one when expanded', async () => {
    setup({ postedPairs: [postedPair()] });
    renderPage();
    expect(await screen.findByText('Possible Transfers')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();

    const amountCell = screen.getByText('$300.00');
    await userEvent.click(amountCell);
    expect(screen.getByText(/Why this looks like a transfer:/)).toBeInTheDocument();
    expect(screen.getByText(/Same amount on both sides \(\$300\.00\)\./)).toBeInTheDocument();
    expect(screen.getByText(/1 day apart/)).toBeInTheDocument();
    expect(screen.getByText('Transfer Out')).toBeInTheDocument();
    expect(screen.getByText('Transfer In')).toBeInTheDocument();
    // Clicking the same row again collapses it.
    await userEvent.click(amountCell);
    expect(screen.queryByText(/Why this looks like a transfer:/)).toBeNull();
  });

  it('describes a same-day posted transfer pair', async () => {
    setup({ postedPairs: [postedPair({ in: { id: 12, account_id: 2, account_name: 'Savings', date: '2026-08-02', merchant: null } })] });
    renderPage();
    await userEvent.click(await screen.findByText('$300.00'));
    expect(screen.getByText(/Posted the same day/)).toBeInTheDocument();
  });

  it('ignores a single posted transfer candidate', async () => {
    setup({ postedPairs: [postedPair()] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/transactions/transfer-suggestions/ignore', { out_id: 11, in_id: 12 }));
    expect(screen.queryByText('Possible Transfers')).toBeNull();
  });

  it('reports a failure when ignoring a posted transfer candidate', async () => {
    setup({ postedPairs: [postedPair()] });
    (api.post as any).mockRejectedValue(new Error('ignore boom'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText('ignore boom')).toBeInTheDocument();
  });

  it('ignores every posted transfer candidate at once', async () => {
    setup({ postedPairs: [postedPair(), postedPair({ key: 'pp-2', out: { id: 21, account_id: 1, account_name: 'Checking', date: '2026-08-02', merchant: 'B' }, in: { id: 22, account_id: 3, account_name: 'Visa', date: '2026-08-02', merchant: 'C' } })] });
    renderPage();
    expect(await screen.findByText('2 to review')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ignore All' }));
    await waitFor(() => expect(screen.queryByText('Possible Transfers')).toBeNull());
    expect((api.post as any).mock.calls.filter((c: any[]) => c[0] === '/transactions/transfer-suggestions/ignore')).toHaveLength(2);
  });

  it('opens the editor seeded as a transfer when reviewing a pair', async () => {
    setup({ postedPairs: [postedPair()] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByText('editor:convert-11-12')).toBeInTheDocument();
    expect(screen.getByText('seed-direction:transfer')).toBeInTheDocument();
    expect(screen.getByText('seed-merchant:Transfer Out')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Save' }));
    await waitFor(() => expect(screen.queryByTestId('txn-editor')).toBeNull());
  });

  it('falls back to the money-in merchant when seeding a transfer', async () => {
    setup({ postedPairs: [postedPair({ out: { id: 11, account_id: 1, account_name: 'Checking', date: '2026-08-02', merchant: null } })] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByText('seed-merchant:Transfer In')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Close' }));
    expect(screen.queryByTestId('txn-editor')).toBeNull();
  });

  // ── Possible Subscriptions ───────────────────────────────────────────────
  it('lists subscription candidates and explains one when expanded', async () => {
    setup({ suggestions: [suggestion()] });
    renderPage();
    expect(await screen.findByText('Possible Subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('4×')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Netflix'));
    expect(screen.getByText(/Why this looks like a subscription:/)).toBeInTheDocument();
    expect(screen.getByText('Recent charges')).toBeInTheDocument();
    expect(screen.getAllByText('−$15.99').length).toBeGreaterThan(0);
  });

  it('ignores one subscription candidate and then all of them', async () => {
    setup({ suggestions: [suggestion(), suggestion({ merchant: 'Spotify', key: 'spotify' })] });
    renderPage();
    expect(await screen.findByText('2 to review')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Ignore' })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscriptions/suggestions/ignore', { merchant: 'Netflix' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ignore All' }));
    await waitFor(() => expect((api.post as any).mock.calls.filter((c: any[]) => c[0] === '/subscriptions/suggestions/ignore').length).toBeGreaterThanOrEqual(3));
  });

  it('reports a failure when ignoring a subscription candidate', async () => {
    setup({ suggestions: [suggestion()] });
    (api.post as any).mockRejectedValue(new Error('sug boom'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText('sug boom')).toBeInTheDocument();
  });

  it('opens the candidate detail from the review button', async () => {
    setup({ suggestions: [suggestion()] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByText('detail:Netflix')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Detail Changed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Detail Close' }));
    expect(screen.queryByTestId('sug-detail')).toBeNull();
  });

  it('flags a matching posted row as a possible subscription and opens its detail', async () => {
    setup({ suggestions: [suggestion({ merchant: 'Netflix', key: 'netflix' })], posted: [txn({ merchant: 'NETFLIX 4432', category_name: 'Groceries' })], total: 1 });
    renderPage();
    const badge = await screen.findByTitle('This merchant looks like a recurring subscription — review it');
    await userEvent.click(badge);
    expect(screen.getByText('detail:Netflix')).toBeInTheDocument();
    // The row itself did not open the editor.
    expect(screen.queryByTestId('txn-editor')).toBeNull();
  });

  // ── Auto Imported queue ──────────────────────────────────────────────────
  it('lists staged rows with their raw merchant and confirms one', async () => {
    setup({ staged: [staged()] });
    renderPage();
    expect(await screen.findByText('Auto Imported')).toBeInTheDocument();
    expect(screen.getByText('1 to post')).toBeInTheDocument();
    expect(screen.getByText('SHELL OIL 4432')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/imports/staged/500/confirm'));
  });

  it('shows the already-in-ledger skip reason', async () => {
    setup({ staged: [staged({ decision: 'skip', skip_reason: 'matches_existing', duplicate_of: 9, dup_merchant: 'Shell', dup_amount: 12.34, dup_date: '2026-08-01' })] });
    renderPage();
    expect(await screen.findByText('⚠ already in ledger')).toBeInTheDocument();
    expect(screen.getByText('0 to post · 1 skipped')).toBeInTheDocument();
    // Confirm All is unavailable with nothing to post.
    expect(screen.getByRole('button', { name: 'Confirm All (0)' })).toBeDisabled();
  });

  it('shows the repeated-in-file skip reason', async () => {
    setup({ staged: [staged({ decision: 'skip', skip_reason: 'duplicate_in_file' })] });
    renderPage();
    expect(await screen.findByText('⚠ repeated in file')).toBeInTheDocument();
  });

  it('derives a legacy skip reason from duplicate_of', async () => {
    setup({ staged: [staged({ decision: 'skip', skip_reason: null, duplicate_of: 77 })] });
    renderPage();
    expect(await screen.findByText('⚠ already in ledger')).toBeInTheDocument();
  });

  it('renders a dash and a no-date marker for a sparse staged row', async () => {
    setup({ staged: [staged({ txn_date: null, merchant: null, raw_merchant: null, account_name: null, direction: 'income' })] });
    renderPage();
    expect(await screen.findByText('no date')).toBeInTheDocument();
    expect(screen.getByText('+$12.34')).toBeInTheDocument();
  });

  it('discards a single staged row', async () => {
    setup({ staged: [staged()] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/imports/staged/500'));
  });

  it('confirms the whole queue after the user agrees', async () => {
    setup({ staged: [staged(), staged({ id: 501 })] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm All (2)' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/imports/staged/confirm'));
  });

  it('leaves the queue alone when the confirm dialog is declined', async () => {
    setup({ staged: [staged()] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm All (1)' }));
    expect(api.post).not.toHaveBeenCalledWith('/imports/staged/confirm');
  });

  it('discards the whole queue after the user agrees', async () => {
    setup({ staged: [staged()] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore All' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/imports/staged'));
  });

  it('opens the editor seeded from a staged row', async () => {
    setup({ staged: [staged()] });
    renderPage();
    await userEvent.click(await screen.findByText('Shell'));
    expect(screen.getByText('editor:staged-500')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editor Save' }));
    await waitFor(() => expect(screen.queryByTestId('txn-editor')).toBeNull());
  });

  it('reports failures from the staged actions', async () => {
    setup({ staged: [staged()] });
    (api.post as any).mockRejectedValue(new Error('confirm boom'));
    (api.del as any).mockRejectedValue(new Error('discard boom'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('confirm boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText('discard boom')).toBeInTheDocument();
  });

  // ── Transfer candidates inside an import ─────────────────────────────────
  it('links a staged transfer pair, optionally remembering it', async () => {
    setup({ staged: [staged()], stagedPairs: [stagedPair()] });
    renderPage();
    expect(await screen.findByText('Possible Transfers in this import')).toBeInTheDocument();
    expect(screen.getByText('−$75.00')).toBeInTheDocument();
    expect(screen.getByText('+$75.00')).toBeInTheDocument();
    await userEvent.click(screen.getByTitle('Always auto-link Checking → Savings on future imports'));
    await userEvent.click(screen.getByRole('button', { name: 'Link as Transfer' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/imports/staged/transfer', { out_id: 601, in_id: 602, remember: true }));
  });

  it('links a staged transfer pair without remembering it', async () => {
    setup({ staged: [staged()], stagedPairs: [stagedPair()] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Link as Transfer' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/imports/staged/transfer', { out_id: 601, in_id: 602, remember: false }));
  });

  it('reports a failure when linking a staged transfer pair', async () => {
    setup({ staged: [staged()], stagedPairs: [stagedPair()] });
    (api.post as any).mockImplementation((p: string) =>
      p === '/imports/staged/transfer' ? Promise.reject(new Error('link boom')) : Promise.resolve({}));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Link as Transfer' }));
    expect(await screen.findByText('link boom')).toBeInTheDocument();
  });

  it('dismisses a staged transfer pair', async () => {
    setup({ staged: [staged()], stagedPairs: [stagedPair()] });
    renderPage();
    const card = (await screen.findByText('Possible Transfers in this import')).closest('.card') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(screen.queryByText('Possible Transfers in this import')).toBeNull());
  });

  // ── Auto-link rules ──────────────────────────────────────────────────────
  it('lists auto-link rules and removes one', async () => {
    setup({ rules: [{ id: 900, source_account_id: 1, source_name: 'Checking', dest_account_id: 2, dest_name: 'Savings' }] });
    renderPage();
    expect(await screen.findByText('Auto-Linked Transfers')).toBeInTheDocument();
    expect(screen.getByText(/Checking → Savings/)).toBeInTheDocument();
    await userEvent.click(screen.getByTitle('Remove this auto-link rule'));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/imports/transfer-rules/900'));
  });

  it('reports a failure when removing an auto-link rule', async () => {
    setup({ rules: [{ id: 900, source_account_id: 1, source_name: 'Checking', dest_account_id: 2, dest_name: 'Savings' }] });
    (api.del as any).mockRejectedValue(new Error('rule boom'));
    renderPage();
    await userEvent.click(await screen.findByTitle('Remove this auto-link rule'));
    expect(await screen.findByText('rule boom')).toBeInTheDocument();
  });

  // ── Collapsible review groups ────────────────────────────────────────────
  it('collapses a review group and remembers it', async () => {
    setup({ suggestions: [suggestion()] });
    renderPage();
    await userEvent.click(await screen.findByText('Possible Subscriptions'));
    await waitFor(() => expect(screen.queryByText('Netflix')).toBeNull());
    expect(localStorage.getItem('review.collapsed.subscriptions')).toBe('1');
  });

  it('starts a review group collapsed when storage says so', async () => {
    localStorage.setItem('review.collapsed.subscriptions', '1');
    setup({ suggestions: [suggestion()] });
    renderPage();
    expect(await screen.findByText('Possible Subscriptions')).toBeInTheDocument();
    expect(screen.queryByText('Netflix')).toBeNull();
    // Re-opening clears the stored flag.
    await userEvent.click(screen.getByText('Possible Subscriptions'));
    expect(await screen.findByText('Netflix')).toBeInTheDocument();
    expect(localStorage.getItem('review.collapsed.subscriptions')).toBe('0');
  });
});

describe('Transactions filters and paging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    locationState = null;
    locationSearch = '';
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('starts from an uncategorized deep link', async () => {
    locationSearch = '?uncategorized=1';
    renderPage();
    await waitFor(() => expect(lastTxnUrl()).toContain('uncategorized=1'));
    // A deep link widens the range to everything, so no date bounds are sent.
    expect(lastTxnUrl()).not.toContain('from=');
    expect(lastTxnUrl()).not.toContain('to=');
  });

  it('starts from an account deep link and clears the navigation state', async () => {
    locationState = { account_id: 2 };
    renderPage();
    await waitFor(() => expect(lastTxnUrl()).toContain('account_id=2'));
    expect(navigateMock).toHaveBeenCalledWith('/transactions', { replace: true, state: null });
  });

  it('opens the advanced panel for a property deep link', async () => {
    locationState = { property_id: 30 };
    renderPage();
    await waitFor(() => expect(lastTxnUrl()).toContain('property_id=30'));
  });

  it('opens the advanced panel for a vehicle deep link', async () => {
    locationState = { vehicle_id: 20 };
    renderPage();
    await waitFor(() => expect(lastTxnUrl()).toContain('vehicle_id=20'));
  });

  it('restores the last-used filters from storage', async () => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ filters: { ...DEFAULT_FILTERS, q: 'coffee', range: 'all' }, advancedOpen: true }));
    renderPage();
    await waitFor(() => expect(lastTxnUrl()).toContain('q=coffee'));
  });

  it('ignores corrupt stored filters', async () => {
    localStorage.setItem(FILTER_KEY, '{not json');
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Transactions', level: 1 })).toBeInTheDocument();
  });

  it('persists the filter selection as it changes', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Transactions', level: 1 });
    await waitFor(() => expect(localStorage.getItem(FILTER_KEY)).toBeTruthy());
    expect(JSON.parse(localStorage.getItem(FILTER_KEY)!)).toHaveProperty('filters');
  });

  it('pages through the posted list', async () => {
    setup({ posted: [txn()], total: 120 });
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Showing 1–1 of 120').length).toBe(2));
    expect(screen.getAllByText('Page 1 of 3').length).toBe(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => expect(lastTxnUrl()).toContain('postedOffset=50'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Previous' })[0]);
    await waitFor(() => expect(lastTxnUrl()).toContain('postedOffset=0'));
  });

  it('pages through the pending list', async () => {
    setup({ pending: [txn({ posted_date: null })], pendingTotal: 80, posted: [], total: 0 });
    renderPage();
    expect(await screen.findByText('80 awaiting posting')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => expect(lastTxnUrl()).toContain('pendingOffset=50'));
  });

  it('clamps the posted page when the total shrinks', async () => {
    setup({ posted: [txn()], total: 120 });
    const base = (api.get as any).getMockImplementation();
    // Standing in for a delete that drops the list to one page while we are on page two:
    // once the shrink happens it stays shrunk, as a real server would report.
    let shrunk = false;
    (api.get as any).mockImplementation((path: string) => {
      if (!path.startsWith('/transactions?')) return base(path);
      if (path.includes('postedOffset=50')) shrunk = true;
      return Promise.resolve({ pending: [], pendingTotal: 0, posted: [txn()], total: shrunk ? 1 : 120 });
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Showing 1–1 of 120').length).toBe(2));
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    // A single page means the pager disappears entirely.
    await waitFor(() => expect(screen.queryAllByText(/Page \d+ of/)).toHaveLength(0));
  });

  it('hides archived tags from the filter lookups', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Transactions', level: 1 });
    expect(screen.queryByText('Old')).toBeNull();
  });
});
