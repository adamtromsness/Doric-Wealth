import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import OtherLiabilities from './OtherLiabilities';

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

const liab = {
  id: 4, name: 'Family Loan', liability_type: 'personal_loan', balance: 5000,
  original_amount: 8000, interest_rate: 3.5, notes: 'from dad',
};

const renderPage = () => render(<MemoryRouter><OtherLiabilities /></MemoryRouter>);

describe('OtherLiabilities page', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    (api.get as any).mockResolvedValue([liab]);
    (api.post as any).mockResolvedValue({ id: 55 });
  });

  it('renders the liability list', async () => {
    renderPage();
    expect(await screen.findByText('Family Loan')).toBeInTheDocument();
    expect(screen.getByText('$5,000.00')).toBeInTheDocument();
    expect(screen.getByText('3.5%')).toBeInTheDocument();
    expect(screen.getByText('$8,000.00')).toBeInTheDocument();
    expect(screen.getByText('from dad')).toBeInTheDocument();
  });

  it('falls back to "Standalone debt" when there are no notes', async () => {
    (api.get as any).mockResolvedValue([{ ...liab, notes: null, interest_rate: null, original_amount: null }]);
    renderPage();
    expect(await screen.findByText('Standalone debt')).toBeInTheDocument();
    // interest rate & original show em dash
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows the empty state', async () => {
    (api.get as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No standalone liabilities yet/)).toBeInTheDocument();
  });

  it('shows an error when the load fails', async () => {
    (api.get as any).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('navigates from the card and the View Details button', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Family Loan');
    await user.click(screen.getByRole('button', { name: /View Details/ }));
    expect(navigateMock).toHaveBeenCalledWith('/other-liabilities/4');
    navigateMock.mockClear();
    await user.click(screen.getByTitle('View liability details'));
    expect(navigateMock).toHaveBeenCalledWith('/other-liabilities/4');
  });

  it('adds a liability: validation, create, and navigate', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No standalone liabilities yet/);
    await user.click(screen.getByRole('button', { name: 'Add Liability' }));
    const modal = () => within(document.querySelector('.modal') as HTMLElement);
    // Save stays disabled until the form is dirty, so a whitespace-only name is
    // what actually reaches the validation branch.
    const nameInput = screen.getByPlaceholderText('e.g. Family loan');
    await user.type(nameInput, '   ');
    await user.click(modal().getByRole('button', { name: 'Add Liability' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.clear(nameInput);
    await user.type(nameInput, 'Car Loan');
    await user.type(screen.getByPlaceholderText('6.25'), '4.2');
    await user.click(modal().getByRole('button', { name: 'Add Liability' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/liabilities', expect.objectContaining({ name: 'Car Loan', liability_type: 'personal_loan', interest_rate: 4.2 })));
    expect(navigateMock).toHaveBeenCalledWith('/other-liabilities/55');
  });

  it('surfaces a save error', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    (api.post as any).mockRejectedValue(new Error('nope'));
    renderPage();
    await screen.findByText(/No standalone liabilities yet/);
    await user.click(screen.getByRole('button', { name: 'Add Liability' }));
    await user.type(screen.getByPlaceholderText('e.g. Family loan'), 'X');
    await user.click(within(document.querySelector('.modal') as HTMLElement).getByRole('button', { name: 'Add Liability' }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  it('closes the add modal', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No standalone liabilities yet/);
    await user.click(screen.getByRole('button', { name: 'Add Liability' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('e.g. Family loan')).toBeNull());
  });
});
