import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Budgets from './Budgets';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const budgets = [
  { id: 1, name: 'Family 2026', period: 'monthly', start_date: '2026-01-01' },
  { id: 2, name: 'Vacation', period: 'weekly', start_date: '2026-06-01' },
];

// Minimal but valid Progress payload so BudgetDetail renders without crashing.
const progress = {
  period: 'monthly',
  window: { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' },
  account_ids: [],
  bucket: 'day' as const,
  daily: [
    { date: '2026-09-01', income: 100, expense: 40, net: 60 },
    { date: '2026-09-02', income: 0, expense: 20, net: -20 },
  ],
  sections: [
    {
      kind: 'income' as const, uncategorized: 0, allocated: 1000, actual: 800, total_actual: 800,
      groups: [],
    },
    {
      kind: 'expense' as const, uncategorized: 0, allocated: 500, actual: 300, total_actual: 300,
      groups: [
        {
          group_id: 10, group_name: 'Housing', allocated: 500, actual: 300,
          lines: [{ line_id: 100, category_id: 11, category_name: 'Rent', allocated: 500, actual: 300 }],
        },
      ],
    },
  ],
};

function mockGet() {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/budgets') return Promise.resolve(budgets);
    if (path.includes('/progress')) return Promise.resolve(progress);
    if (path === '/categories') return Promise.resolve([]);
    if (path === '/accounts') return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

const renderPage = () => render(<MemoryRouter><Budgets /></MemoryRouter>);

describe('Budgets page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGet();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
  });

  it('renders the header, the budget selector, and the selected budget detail', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Budgets')).toBeInTheDocument());
    // Both budget buttons are shown.
    expect(screen.getByRole('button', { name: /Family 2026/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Vacation/ })).toBeInTheDocument();
    // The first budget is auto-selected -> its detail (window label) renders.
    await waitFor(() => expect(screen.getByText('September 2026')).toBeInTheDocument());
  });

  it('shows the empty state when there are no budgets', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/budgets' ? Promise.resolve([]) : Promise.resolve([]));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No budgets yet/)).toBeInTheDocument());
  });

  it('shows an error when the budgets request fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/budgets' ? Promise.reject(new Error('budgets boom')) : Promise.resolve([]));
    renderPage();
    await waitFor(() => expect(screen.getByText('budgets boom')).toBeInTheDocument());
  });

  it('switches the selected budget and persists the choice to localStorage', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('September 2026')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Vacation/ }));
    await waitFor(() => expect(localStorage.getItem('budgets.selectedId')).toBe('2'));
  });

  it('restores the previously-selected budget from localStorage', async () => {
    localStorage.setItem('budgets.selectedId', '2');
    renderPage();
    // Vacation (id 2) should be the highlighted (non-ghost) button.
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Vacation/ });
      expect(btn.className).not.toContain('ghost');
    });
  });

  it('opens the New Budget modal and creates a budget', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Budgets')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'New Budget' }));
    const modal = document.querySelector('.scrim') as HTMLElement;
    await waitFor(() => expect(within(modal).getByText('New Budget')).toBeInTheDocument());
    await userEvent.type(within(modal).getByPlaceholderText('Family 2026'), 'New Plan');
    await userEvent.click(within(modal).getByRole('button', { name: 'Create Budget' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/budgets', expect.objectContaining({ name: 'New Plan', period: 'monthly' })));
    // Modal closes after save.
    await waitFor(() => expect(document.querySelector('.scrim')).toBeNull());
  });

  it('closes the New Budget modal via the scrim without saving', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Budgets')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'New Budget' }));
    await waitFor(() => expect(document.querySelector('.scrim')).toBeInTheDocument());
    await userEvent.click(document.querySelector('.scrim') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.scrim')).toBeNull());
    expect(api.post).not.toHaveBeenCalledWith('/budgets', expect.anything());
  });

  it('deletes the selected budget and reloads', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('September 2026')).toBeInTheDocument());
    // The Delete button lives in the BudgetDetail header.
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/budgets/1'));
  });
});
