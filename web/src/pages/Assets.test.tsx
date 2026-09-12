import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Assets from './Assets';

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
  '/networth': { totals: { assets: 200000, liabilities: 0, netWorth: 200000 } },
  '/accounts': [
    { id: 1, name: 'Checking', type: 'checking', posted_balance: 5000, is_liability: false, status: 'active' },
    { id: 2, name: 'Old', type: 'savings', posted_balance: 100, is_liability: false, status: 'closed' },
    { id: 3, name: 'Card', type: 'credit_card', posted_balance: -50, is_liability: true, status: 'active' },
  ],
  '/properties': [
    { id: 10, name: 'Home', current_value: 120000, disposed_at: null },
    { id: 11, name: 'Sold', current_value: 90000, disposed_at: '2025-01-01' },
  ],
  '/vehicles': [
    { id: 20, name: 'Car', current_value: 15000, disposed_at: null },
    { id: 21, name: 'GoneCar', current_value: 3000, disposed_at: '2025-05-01' },
  ],
  '/assets': [
    { id: 30, name: 'Boat', asset_type: 'boat', value: 20000 },
    { id: 31, name: 'Coin', asset_type: 'collectible', value: 500 },
  ],
  '/networth/asset-history': { series: [{ date: '2026-01-01', value: 150000 }, { date: '2026-06-01', value: 200000 }] },
};

function setup(over: Record<string, any> = {}) {
  const map = { ...fixtures, ...over };
  (api.get as any).mockImplementation((path: string) =>
    map[path] !== undefined ? Promise.resolve(map[path]) : Promise.resolve({}));
}

const renderPage = () => render(<MemoryRouter><Assets /></MemoryRouter>);

describe('Assets dashboard', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    localStorage.clear();
    setup();
  });

  it('renders category tiles, charts, and grouped lists after load', async () => {
    renderPage();
    expect(await screen.findByText('Asset Dashboard')).toBeInTheDocument();
    // KPI tiles (scoped by their title so they don't collide with the footer links).
    expect(screen.getByTitle('Open Asset Accounts')).toBeInTheDocument();
    expect(screen.getByTitle('Open Properties')).toBeInTheDocument();
    // Charts present
    expect(screen.getByText('Asset Value Over Time')).toBeInTheDocument();
    expect(screen.getByText('Allocation')).toBeInTheDocument();
    expect(screen.getByText('Largest Assets')).toBeInTheDocument();
    // Items present in the lists. Scoped by row title: the chart axes render the
    // same names, so a bare text query is ambiguous.
    expect(screen.getByTitle('Open Home')).toBeInTheDocument();
    expect(screen.getByTitle('Open Boat')).toBeInTheDocument();
    // Closed account and disposed items excluded
    expect(screen.queryByTitle('Open Old')).toBeNull();
    expect(screen.queryByTitle('Open Sold')).toBeNull();
  });

  it('shows a loading state before data arrives', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an error when the networth request fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/networth' ? Promise.reject(new Error('nw failed')) : Promise.resolve([]));
    renderPage();
    expect(await screen.findByText('nw failed')).toBeInTheDocument();
  });

  it('shows the empty state when there are no assets', async () => {
    setup({ '/accounts': [], '/properties': [], '/vehicles': [], '/assets': [], '/networth/asset-history': { series: [] } });
    renderPage();
    expect(await screen.findByText(/No assets tracked yet/)).toBeInTheDocument();
  });

  it('navigates to a manage page when a KPI tile is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTitle('Open Properties'));
    expect(navigateMock).toHaveBeenCalledWith('/properties');
  });

  it('navigates to an item detail when a list row is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTitle('Open Home'));
    expect(navigateMock).toHaveBeenCalledWith('/properties/10');
  });

  it('toggles charts off and persists the preference', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Asset Dashboard');
    await user.click(screen.getByRole('button', { name: 'Hide Charts' }));
    expect(screen.getByRole('button', { name: 'Show Charts' })).toBeInTheDocument();
    expect(localStorage.getItem('assets.hideCharts')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Show Charts' }));
    expect(localStorage.getItem('assets.hideCharts')).toBe('0');
  });

  it('respects a stored hideCharts preference on mount', async () => {
    localStorage.setItem('assets.hideCharts', '1');
    renderPage();
    await screen.findByText('Asset Dashboard');
    expect(screen.getByRole('button', { name: 'Show Charts' })).toBeInTheDocument();
    expect(screen.queryByText('Allocation')).toBeNull();
  });

  it('collapses a group and persists it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Home');
    // The Properties group header toggles collapse.
    const header = screen.getByText(/Properties · 1/);
    await user.click(header);
    await waitFor(() => expect(screen.queryByTitle('Open Home')).toBeNull());
    const stored = JSON.parse(localStorage.getItem('assets.collapsed') || '{}');
    expect(stored.properties).toBe(true);
  });

  it('handles a corrupt collapsed value in storage', async () => {
    localStorage.setItem('assets.collapsed', 'not json');
    renderPage();
    expect(await screen.findByText('Asset Dashboard')).toBeInTheDocument();
  });

  it('tolerates individual endpoint failures via catch fallbacks', async () => {
    (api.get as any).mockImplementation((path: string) => {
      if (path === '/networth') return Promise.resolve(fixtures['/networth']);
      if (path === '/networth/asset-history') return Promise.reject(new Error('x'));
      return Promise.reject(new Error('x'));
    });
    renderPage();
    // networth resolves, everything else falls back to empty -> empty state.
    expect(await screen.findByText(/No assets tracked yet/)).toBeInTheDocument();
  });
});
