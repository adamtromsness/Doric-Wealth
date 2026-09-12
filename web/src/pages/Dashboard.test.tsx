import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

// Keep the real pure helpers (money, shortDate); mock only the network `api`.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn() } };
});
import { api } from '../api';

const fixtures: Record<string, any> = {
  '/dashboard': {
    netWorth: 125000,
    assets: 150000,
    liabilities: 25000,
    series: [{ date: '2026-01-01', net_worth: 100000 }, { date: '2026-03-01', net_worth: 125000 }],
    monthFlow: [{ direction: 'income', total: 5000 }, { direction: 'expense', total: 3200 }],
    categorySpend: [{ name: 'Groceries', total: 800 }, { name: 'Rent', total: 1500 }],
  },
  '/todos': { setupOpen: 2, attention: [{ kind: 'bill', title: 'Bill due', link: '/reminders', severity: 'warn' }] },
  '/networth': { assetGroups: [{ type: 'cash', label: 'Cash', total: 20000, count: 1 }] },
  '/reminders': [{ kind: 'renewal', title: 'Netflix', subtitle: null, date: '2026-03-20', amount: 15, link: '/subscriptions' }],
  '/networth/over-time': { series: [{ date: '2026-01-01', assets: 1, liabilities: 0, net_worth: 100000 }, { date: '2026-03-01', assets: 1, liabilities: 0, net_worth: 125000 }] },
  '/networth/cash-flow?months=12': { series: [{ month: '2026-01', income: 5000, expense: 3200, net: 1800 }] },
};

describe('Dashboard page', () => {
  beforeEach(() => {
    (api.get as any).mockImplementation((path: string) => Promise.resolve(fixtures[path] ?? {}));
  });

  const renderPage = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

  it('renders net worth and the section scaffolding after data loads', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
    // Net worth hero value ($125,000.00) is rendered from the real money() helper.
    expect(screen.getByText('$125,000.00')).toBeInTheDocument();
    expect(screen.getByText('Asset Dashboard')).toBeInTheDocument();
    // Action items surfaced from /todos.
    expect(screen.getByText(/Finish setup/)).toBeInTheDocument();
  });

  it('shows an error message when the dashboard request fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/dashboard' ? Promise.reject(new Error('boom')) : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('shows a loading state before data arrives', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
