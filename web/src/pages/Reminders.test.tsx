import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Reminders from './Reminders';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

// Build ISO dates relative to today so daysUntil bucketing is deterministic.
const iso = (offsetDays: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const reminders = [
  { source: 'sub', kind: 'renewal', title: 'Netflix', subtitle: 'Streaming', date: iso(-3), amount: 15, link: '/subscriptions/1' },
  { source: 'bill', kind: 'bill_due', title: 'Electric bill', subtitle: null, date: iso(5), amount: 80, link: '/utilities' },
  { source: 'other', kind: 'weird_kind', title: 'Something later', subtitle: null, date: iso(45), amount: null, link: '/x' },
];

const todos = {
  setupOpen: 2,
  setup: [
    { key: 'accounts', title: 'Add an account', description: 'Start here', link: '/accounts', dismissible: true, done: false, dismissed: false },
    { key: 'done-one', title: 'Already done', description: 'n/a', link: '/done', dismissible: false, done: true, dismissed: false },
    { key: 'skipped-one', title: 'Skipped item', description: 'skip me', link: '/skip', dismissible: true, done: false, dismissed: true },
  ],
  attention: [
    { kind: 'uncat', title: 'Uncategorized transactions', count: 4, link: '/transactions', severity: 'warn' as const },
    { kind: 'neg', title: 'Negative balance', count: 1, link: '/accounts', severity: 'debit' as const },
    { kind: 'info', title: 'Info item', count: 2, link: '/info', severity: 'info' as const },
  ],
};

const fixtures: Record<string, any> = { '/reminders': reminders, '/todos': todos };

const renderPage = () => render(<MemoryRouter><Reminders /></MemoryRouter>);

describe('Reminders page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockImplementation((path: string) => Promise.resolve(fixtures[path] ?? {}));
    (api.post as any).mockResolvedValue({});
  });

  it('renders attention, setup checklist, and grouped upcoming reminders', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('To-Do')).toBeInTheDocument());
    // Attention section
    expect(screen.getByText(/Needs attention · 3/)).toBeInTheDocument();
    expect(screen.getByText('Uncategorized transactions')).toBeInTheDocument();
    // Setup checklist (2 open)
    expect(screen.getByText(/Get set up/)).toBeInTheDocument();
    expect(screen.getByText('Add an account')).toBeInTheDocument();
    expect(screen.getByText('Already done')).toBeInTheDocument();
    // Grouped reminders
    expect(screen.getByText(/Overdue · 1/)).toBeInTheDocument();
    expect(screen.getByText(/Next 30 Days · 1/)).toBeInTheDocument();
    expect(screen.getByText(/Later · 1/)).toBeInTheDocument();
    // Known kind label + fallback kind label
    expect(screen.getByText('Renewal')).toBeInTheDocument();
    expect(screen.getByText('weird_kind')).toBeInTheDocument();
    // Amount rendered via money() and blank amount tolerated
    expect(screen.getByText('$15.00')).toBeInTheDocument();
  });

  it('navigates when a reminder row and an attention row are clicked', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Netflix'));
    expect(navigateMock).toHaveBeenCalledWith('/subscriptions/1');
    await userEvent.click(screen.getByText('Negative balance'));
    expect(navigateMock).toHaveBeenCalledWith('/accounts');
  });

  it('navigates from an open setup item but not a done one', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Add an account')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Add an account'));
    expect(navigateMock).toHaveBeenCalledWith('/accounts');
    navigateMock.mockClear();
    await userEvent.click(screen.getByText('Already done'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('skips a setup item, then shows/restores skipped items', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Skip')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Skip'));
    expect(api.post).toHaveBeenCalledWith('/todos/dismiss', { key: 'accounts' });

    // Reveal skipped list, then restore.
    await userEvent.click(screen.getByText('show'));
    expect(screen.getByText('Skipped item')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Restore'));
    expect(api.post).toHaveBeenCalledWith('/todos/undismiss', { key: 'skipped-one' });
    // Toggle back to hide.
    await userEvent.click(screen.getByText('hide'));
    await waitFor(() => expect(screen.queryByText('Skipped item')).toBeNull());
  });

  it('shows the empty upcoming state when there are no reminders', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/reminders' ? Promise.resolve([]) : Promise.resolve({ setup: [], attention: [], setupOpen: 0 }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Nothing due in the next 60 days/)).toBeInTheDocument());
  });

  it('shows an error when /reminders fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/reminders' ? Promise.reject(new Error('boom')) : Promise.resolve(todos));
    renderPage();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('surfaces an error when dismiss fails', async () => {
    (api.post as any).mockRejectedValue(new Error('dismiss failed'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Skip')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Skip'));
    await waitFor(() => expect(screen.getByText('dismiss failed')).toBeInTheDocument());
  });
});
