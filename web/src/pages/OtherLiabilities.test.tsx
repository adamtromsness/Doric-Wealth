import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('Add Liability opens the add page instead of a popup', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No standalone liabilities yet/);
    await user.click(screen.getByRole('button', { name: 'Add Liability' }));
    expect(navigateMock).toHaveBeenCalledWith('/other-liabilities/new');
    expect(document.querySelector('.modal')).toBeNull();
  });
});
