import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Liabilities from './Liabilities';

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

const fixtures: Record<string, any> = {
  '/networth': { totals: { assets: 0, liabilities: 300000, netWorth: -300000 } },
  '/accounts': [
    { id: 1, name: 'Visa', type: 'credit_card', posted_balance: 2000, is_liability: true, status: 'active' },
    { id: 2, name: 'Car Loan', type: 'loan', posted_balance: 15000, is_liability: true, status: 'active' },
    { id: 3, name: 'Mortgage Acct', type: 'mortgage', posted_balance: 250000, is_liability: true, status: 'active' },
    { id: 4, name: 'Closed Card', type: 'credit_card', posted_balance: 10, is_liability: true, status: 'closed' },
    { id: 5, name: 'Checking', type: 'checking', posted_balance: 500, is_liability: false, status: 'active' },
  ],
  '/properties': [
    { id: 10, name: 'Home', mortgage_account_id: 3, mortgage_balance: 0, disposed_at: null },
    { id: 11, name: 'Cabin', mortgage_account_id: null, mortgage_balance: 40000, disposed_at: null },
    { id: 12, name: 'SoldHouse', mortgage_account_id: null, mortgage_balance: 5000, disposed_at: '2025-01-01' },
  ],
  '/vehicles': [
    { id: 20, name: 'Truck', loan_account_id: 2 },
  ],
  '/liabilities': [
    { id: 30, name: 'Family Loan', liability_type: 'personal_loan', balance: 5000 },
    { id: 31, name: 'Weird', liability_type: 'unknown_type', balance: 1000 },
  ],
  '/networth/liability-history': { series: [{ date: '2026-01-01', value: 320000 }, { date: '2026-06-01', value: 300000 }] },
};

function setup(over: Record<string, any> = {}) {
  const map = { ...fixtures, ...over };
  (api.get as any).mockImplementation((path: string) =>
    map[path] !== undefined ? Promise.resolve(map[path]) : Promise.resolve({}));
}

const renderPage = () => render(<MemoryRouter><Liabilities /></MemoryRouter>);

describe('Liabilities dashboard', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    localStorage.clear();
    setup();
  });

  it('renders tiles, charts, and grouped lists with classified accounts', async () => {
    renderPage();
    expect(await screen.findByText('Liability Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Balance Owed Over Time')).toBeInTheDocument();
    expect(screen.getByText('Allocation by Type')).toBeInTheDocument();
    expect(screen.getByText('Largest Debts')).toBeInTheDocument();
    // Vehicle loan classified as auto, mortgage account as mortgage, standalone shown.
    expect(screen.getByTitle('Open Visa')).toBeInTheDocument();
    expect(screen.getByTitle('Open Car Loan')).toBeInTheDocument();
    expect(screen.getByTitle('Open Family Loan')).toBeInTheDocument();
    expect(screen.getByTitle('Open Cabin')).toBeInTheDocument();
    // Vehicle-linked sub label
    expect(screen.getByText(/Vehicle · Truck/)).toBeInTheDocument();
    // Excluded: closed card, non-liability checking, disposed house, property with a mortgage account
    expect(screen.queryByTitle('Open Closed Card')).toBeNull();
    expect(screen.queryByTitle('Open Checking')).toBeNull();
    expect(screen.queryByTitle('Open SoldHouse')).toBeNull();
  });

  it('shows a loading state', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an error when networth fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/networth' ? Promise.reject(new Error('nw boom')) : Promise.resolve([]));
    renderPage();
    expect(await screen.findByText('nw boom')).toBeInTheDocument();
  });

  it('shows the empty state when there are no liabilities', async () => {
    setup({ '/accounts': [], '/properties': [], '/vehicles': [], '/liabilities': [], '/networth/liability-history': { series: [] } });
    renderPage();
    expect(await screen.findByText(/No liabilities tracked yet/)).toBeInTheDocument();
  });

  it('navigates to an item when a row is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTitle('Open Family Loan'));
    expect(navigateMock).toHaveBeenCalledWith('/other-liabilities/30');
  });

  it('expands a group and scrolls when a KPI tile is clicked', async () => {
    const user = userEvent.setup();
    // The global test setup stubs scrollIntoView on HTMLElement.prototype, which
    // shadows Element.prototype — spy on the same object the element resolves to.
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    renderPage();
    // Tiles only exist once the data has loaded.
    await user.click(await screen.findByTitle(/Jump to Credit Cards/));
    // goToGroup defers the scroll by 50ms.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('toggles charts and persists the preference', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Liability Dashboard');
    await user.click(screen.getByRole('button', { name: 'Hide Charts' }));
    expect(localStorage.getItem('liabilities.hideCharts')).toBe('1');
    expect(screen.getByRole('button', { name: 'Show Charts' })).toBeInTheDocument();
  });

  it('respects a stored hideCharts preference', async () => {
    localStorage.setItem('liabilities.hideCharts', '1');
    renderPage();
    await screen.findByText('Liability Dashboard');
    expect(screen.getByRole('button', { name: 'Show Charts' })).toBeInTheDocument();
  });

  it('collapses a group via its header and persists it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTitle('Open Family Loan');
    await user.click(screen.getByText(/Personal Loans · 1/));
    await waitFor(() => expect(screen.queryByTitle('Open Family Loan')).toBeNull());
    const stored = JSON.parse(localStorage.getItem('liabilities.collapsed') || '{}');
    expect(stored.personal_loan).toBe(true);
  });

  it('handles a corrupt collapsed value in storage', async () => {
    localStorage.setItem('liabilities.collapsed', '{bad');
    renderPage();
    expect(await screen.findByText('Liability Dashboard')).toBeInTheDocument();
  });

  it('tolerates endpoint failures via catch fallbacks', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/networth' ? Promise.resolve(fixtures['/networth']) : Promise.reject(new Error('x')));
    renderPage();
    expect(await screen.findByText(/No liabilities tracked yet/)).toBeInTheDocument();
  });
});
