import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LinkedAccounts from './LinkedAccounts';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(),
    apiDownload: vi.fn(),
    apiBlob: vi.fn(),
  };
});
import { api, apiStream } from '../api';

const navMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navMock };
});

const linkedAcct = (o: Partial<any>) => ({
  id: 0, link_id: 1, external_account_id: 'ext-0', sf_name: null, org_name: null, currency: 'USD',
  last_balance: null, account_id: null, account_name: null, auto_import: true,
  missing_since: null, dismissed_fields: {}, ...o,
});
const conn = (o: Partial<any>) => ({
  id: 1, provider: 'simplefin', status: 'active', last_error: null, account_errors: [],
  last_synced_at: '2026-02-01T10:00:00', connected_at: '2026-01-01T09:00:00',
  include_pending: false, auto_import_enabled: false, auto_import_frequency: 'daily',
  auto_import_start_at: null, accounts: [], ...o,
});

// One connection with a mapped account (id 100) and an unmapped one (id 101).
const CONNS = [
  conn({
    id: 1,
    accounts: [
      linkedAcct({ id: 100, external_account_id: 'ext-A', sf_name: 'Bank Checking', org_name: 'Big Bank', last_balance: 1234.5, account_id: 5, account_name: 'My Checking', auto_import: true }),
      linkedAcct({ id: 101, external_account_id: 'ext-B', sf_name: 'Bank Savings', org_name: 'Big Bank', last_balance: 999, account_id: null }),
    ],
  }),
];

const ACCOUNTS = [
  { id: 5, name: 'My Checking', institution: 'My Bank', currency: 'USD' },
  { id: 6, name: 'Other', institution: null, currency: null },
];

const fixtures: Record<string, any> = {
  '/connections': CONNS,
  '/accounts': ACCOUNTS,
};

const getImpl = (over?: Record<string, any>) => (p: string) =>
  Promise.resolve((over ?? fixtures)[p] ?? {});

describe('LinkedAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockImplementation(getImpl());
    (api.post as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    (apiStream as any).mockResolvedValue(undefined);
  });

  const renderPage = () => render(<MemoryRouter><LinkedAccounts /></MemoryRouter>);

  it('shows a loading state, then the overview with connections', async () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
  });

  it('renders the overview grouped by institution', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    expect(screen.getAllByText('simplefin').length).toBeGreaterThan(0);
    expect(screen.getByText(/last synced/)).toBeInTheDocument();
    // mapped 1/2 shown.
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('shows the empty overview state when there are no connections', async () => {
    (api.get as any).mockImplementation(getImpl({ '/connections': [], '/accounts': [] }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No connections yet/)).toBeInTheDocument());
  });

  it('surfaces a load error', async () => {
    (api.get as any).mockImplementation((p: string) =>
      p === '/connections' ? Promise.reject(new Error('conn fail')) : getImpl()(p));
    renderPage();
    await waitFor(() => expect(screen.getByText('conn fail')).toBeInTheDocument());
  });

  it('validates and connects a token', async () => {
    const user = userEvent.setup();
    (api.post as any).mockResolvedValue({ accounts: [{}, {}] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Token' }));
    // Empty token -> validation error.
    await user.click(screen.getByRole('button', { name: /Connect Institution/ }));
    expect(await screen.findByText(/Paste your SimpleFIN setup token first/)).toBeInTheDocument();
    // Paste + connect.
    await user.type(screen.getByPlaceholderText(/Paste your SimpleFIN setup token/), 'tok-123');
    await user.click(screen.getByRole('button', { name: /Connect Institution/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections/simplefin/claim', { setupToken: 'tok-123' }));
    expect(await screen.findByText(/Connected — found 2 accounts/)).toBeInTheDocument();
  });

  it('maps an account and saves changed settings', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    // The unmapped account's select -> pick account 6.
    const selects = screen.getAllByRole('combobox');
    // Second select corresponds to ext-B (unmapped).
    await user.selectOptions(selects[1], '6');
    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections/1/map', expect.objectContaining({
      mappings: [{ external_account_id: 'ext-B', account_id: 6 }],
    })));
  });

  it('opens the create-account modal and creates an account', async () => {
    const user = userEvent.setup();
    (api.post as any).mockImplementation((path: string) =>
      path.includes('/create-account') ? Promise.resolve({ id: 77, name: 'New Acct' }) : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Create Account from SimpleFIN')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create & Link/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections/1/create-account', expect.objectContaining({ external_account_id: 'ext-B' })));
    expect(await screen.findByText(/Created/)).toBeInTheDocument();
  });

  it('deletes a connection after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/connections/1'));
  });

  it('does not delete when the confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('refreshes a connection and streams progress + a done event', async () => {
    const user = userEvent.setup();
    (apiStream as any).mockImplementation(async (_url: string, _body: any, cb: (ev: any) => void) => {
      cb({ type: 'start' });
      cb({ type: 'status', total: 3, message: 'Contacting…' });
      cb({ type: 'progress', done: 1, total: 3, message: 'Updated 1/3' });
      cb({ type: 'done', added: 2, total: 3 });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await user.click(screen.getByRole('button', { name: /Refresh Accounts/ }));
    await waitFor(() => expect(apiStream).toHaveBeenCalled());
    expect(await screen.findByText(/Found 2 new accounts/)).toBeInTheDocument();
  });

  it('handles a stream error event during refresh', async () => {
    const user = userEvent.setup();
    (apiStream as any).mockImplementation(async (_url: string, _body: any, cb: (ev: any) => void) => {
      cb({ type: 'error', message: 'stream boom' });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await user.click(screen.getByRole('button', { name: /Refresh Accounts/ }));
    expect(await screen.findByText('stream boom')).toBeInTheDocument();
  });

  it('shows suggestions and applies / ignores one', async () => {
    const user = userEvent.setup();
    // Make SimpleFIN report a different name for the mapped account so a suggestion appears.
    // Only the name differs (institution + currency match) so exactly one suggestion.
    const withSug = [conn({
      id: 1,
      accounts: [linkedAcct({ id: 100, external_account_id: 'ext-A', sf_name: 'Renamed Checking', org_name: 'My Bank', currency: 'USD', account_id: 5, account_name: 'My Checking' })],
    })];
    (api.get as any).mockImplementation(getImpl({ '/connections': withSug, '/accounts': ACCOUNTS }));
    renderPage();
    await waitFor(() => expect(screen.getByText('My Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    const sugCard = (await screen.findByText(/Suggested Updates from SimpleFIN/)).closest('.card')! as HTMLElement;
    // Apply the name suggestion.
    await user.click(within(sugCard).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections/1/apply-settings', { external_account_id: 'ext-A', field: 'name' }));
  });

  it('ignores a suggestion', async () => {
    const user = userEvent.setup();
    const withSug = [conn({
      id: 1,
      accounts: [linkedAcct({ id: 100, external_account_id: 'ext-A', sf_name: 'Renamed Checking', org_name: 'My Bank', currency: 'USD', account_id: 5, account_name: 'My Checking' })],
    })];
    (api.get as any).mockImplementation(getImpl({ '/connections': withSug, '/accounts': ACCOUNTS }));
    renderPage();
    await waitFor(() => expect(screen.getByText('My Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    const sugCard = (await screen.findByText(/Suggested Updates from SimpleFIN/)).closest('.card')! as HTMLElement;
    await user.click(within(sugCard).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections/1/dismiss-suggestion', expect.objectContaining({ field: 'name' })));
  });

  it('navigates to Transactions from the accounts footer link', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await user.click(screen.getByText(/Transactions page/));
    expect(navMock).toHaveBeenCalledWith('/transactions');
  });

  it('renders the Token tab table with active tokens', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Token' }));
    expect(screen.getByText(/Active Token/)).toBeInTheDocument();
    expect(screen.getByText('Add a Connection')).toBeInTheDocument();
  });

  it('configures import settings in the Imports tab', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Big Bank')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Imports' }));
    // Pending imports are off for now: no toggle for them.
    expect(screen.queryByText('Include pending transactions')).toBeNull();
    // Enable scheduled auto-import to reveal frequency/start controls.
    await user.click(screen.getByText('Automatically import on a schedule'));
    expect(screen.getByText('Frequency')).toBeInTheDocument();
    // Mapped account (id 100) is auto-import toggleable.
    expect(screen.getByText('Accounts to auto-import')).toBeInTheDocument();
    // Save the dirty draft.
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections/1/settings', expect.objectContaining({ auto_import_enabled: true })));
  });

  it('shows the imports empty state without connections', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(getImpl({ '/connections': [], '/accounts': [] }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No connections yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Imports' }));
    expect(screen.getByText(/Connect a bank in the Token tab first/)).toBeInTheDocument();
  });

  it('shows an attention block when a connection has errors', async () => {
    const errConn = [conn({
      id: 1, status: 'error', last_error: 'auth expired',
      account_errors: ['acct problem'],
      accounts: [linkedAcct({ id: 100, external_account_id: 'ext-A', org_name: 'Big Bank', missing_since: '2026-02-01' })],
    })];
    (api.get as any).mockImplementation(getImpl({ '/connections': errConn, '/accounts': ACCOUNTS }));
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0));
    expect(screen.getByText('auth expired')).toBeInTheDocument();
    expect(screen.getByText('acct problem')).toBeInTheDocument();
    expect(screen.getByText(/stopped appearing/)).toBeInTheDocument();
  });
});
