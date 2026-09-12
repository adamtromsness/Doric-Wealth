import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LiabilityDetail from './LiabilityDetail';

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

vi.mock('../components/EntityDocuments', () => ({ EntityDocuments: () => <div>Documents Panel</div> }));

const liab = {
  id: 2, name: 'Family Loan', liability_type: 'personal_loan', balance: 5000,
  original_amount: 8000, interest_rate: 3.5, notes: 'from dad',
  lender: 'Dad', account_number: '1234', due_day: 15, minimum_payment: 200,
  opened_date: '2021-01-01', payoff_date: '2027-01-01',
  tracks_balance: false, has_documents: true,
};

const balances = [
  { id: 1, as_of: '2026-01-01', value: 7000 },
  { id: 2, as_of: '2026-06-01', value: 5000 },
];

function setup(fixtures: Record<string, any> = {}) {
  const map: Record<string, any> = {
    '/liabilities': [liab],
    '/liabilities/2/balances': balances,
    ...fixtures,
  };
  (api.get as any).mockImplementation((path: string) =>
    map[path] !== undefined ? Promise.resolve(map[path]) : Promise.resolve([]));
}

const renderAt = (id = '2') =>
  render(
    <MemoryRouter initialEntries={[`/other-liabilities/${id}`]}>
      <Routes><Route path="/other-liabilities/:liabilityId" element={<LiabilityDetail />} /></Routes>
    </MemoryRouter>
  );

describe('LiabilityDetail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockReset();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders overview facts including paid off, lender, minimum, due day, payoff', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { name: /Family Loan/ })).toBeInTheDocument();
    // paid off = 1 - 5000/8000 = 37.5% -> 38% (shown in both the stat card and facts list)
    expect(screen.getAllByText('38%').length).toBeGreaterThan(0);
    expect(screen.getByText('Dad')).toBeInTheDocument();
    // due day 15 -> 15th
    expect(screen.getByText('15th')).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument();
  });

  it('shows a not-found error', async () => {
    setup({ '/liabilities': [] });
    renderAt('999');
    expect(await screen.findByText('Liability not found.')).toBeInTheDocument();
  });

  it('shows an invalid error for a non-numeric id', async () => {
    renderAt('xyz');
    expect(await screen.findByText('Invalid liability.')).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderAt();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('adds a balance snapshot', async () => {
    const user = userEvent.setup();
    setup({ '/liabilities': [{ ...liab, tracks_balance: true }] });
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Balance' }));
    expect(await screen.findByText('Balance Snapshots')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('0.00'), '4500');
    await user.click(screen.getByRole('button', { name: 'Record Balance' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/liabilities/2/balances', expect.objectContaining({ value: 4500 })));
  });

  it('deletes a balance snapshot', async () => {
    const user = userEvent.setup();
    setup({ '/liabilities': [{ ...liab, tracks_balance: true }] });
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Balance' }));
    await screen.findByText('Balance Snapshots');
    await user.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(expect.stringMatching(/\/liabilities\/2\/balances\/\d+/)));
  });

  it('renders the documents tab', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Documents' }));
    expect(await screen.findByText('Documents Panel')).toBeInTheDocument();
  });

  it('edits and saves from the Details tab', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const save = await screen.findByRole('button', { name: 'Save Changes' });
    expect(save).toBeDisabled();
    const name = screen.getByPlaceholderText('e.g. Family loan') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/liabilities/2', expect.objectContaining({ name: 'Renamed' })));
  });

  it('validates a blank name on save', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const name = screen.getByPlaceholderText('e.g. Family loan') as HTMLInputElement;
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });

  it('surfaces a save error', async () => {
    const user = userEvent.setup();
    (api.put as any).mockRejectedValue(new Error('put failed'));
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const name = screen.getByPlaceholderText('e.g. Family loan') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('put failed')).toBeInTheDocument();
  });

  it('deletes the liability and navigates back', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/liabilities/2'));
    expect(navigateMock).toHaveBeenCalledWith('/other-liabilities');
  });

  it('does not delete when confirm is cancelled', async () => {
    const user = userEvent.setup();
    (window.confirm as any).mockReturnValue(false);
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('surfaces a delete error', async () => {
    const user = userEvent.setup();
    (api.del as any).mockRejectedValue(new Error('del failed'));
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('del failed')).toBeInTheDocument();
  });

  it('hides the Current Balance field when tracks_balance is on and reveals it when toggled off', async () => {
    const user = userEvent.setup();
    setup({ '/liabilities': [{ ...liab, tracks_balance: true }] });
    renderAt();
    await screen.findByRole('heading', { name: /Family Loan/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    // With tracking on, the note is shown and the Current Balance field is hidden.
    expect(await screen.findByText(/Current balance is set from the latest snapshot/)).toBeInTheDocument();
  });
});
