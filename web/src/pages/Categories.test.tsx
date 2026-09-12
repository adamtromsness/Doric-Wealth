import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Categories from './Categories';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});
import { api } from '../api';

const navMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navMock };
});

const cat = (o: Partial<any>) => ({
  id: 0, name: '', kind: 'expense', parent_id: null, parent_name: null,
  has_children: false, sort_order: 0, managed: false, source_kind: null, archived_at: null, ...o,
});

// Category tree used across most tests.
const CATEGORIES = [
  cat({ id: 1, name: 'Salary Group', kind: 'income', has_children: true, sort_order: 0 }),
  cat({ id: 2, name: 'Paycheck', kind: 'income', parent_id: 1, sort_order: 0 }),
  cat({ id: 10, name: 'Housing', kind: 'expense', has_children: true, sort_order: 0 }),
  cat({ id: 11, name: 'Rent', kind: 'expense', parent_id: 10, sort_order: 0 }),
  cat({ id: 12, name: 'Utilities Bill', kind: 'expense', parent_id: 10, sort_order: 1 }),
  cat({ id: 20, name: 'Empty Group', kind: 'expense', has_children: false, sort_order: 1 }),
  cat({ id: 30, name: 'Utilities', kind: 'expense', managed: true, source_kind: 'utilities', has_children: true, sort_order: 0 }),
  cat({ id: 31, name: 'Electric', kind: 'expense', parent_id: 30, managed: true, sort_order: 0 }),
  cat({ id: 40, name: 'Old Category', kind: 'expense', parent_id: 10, parent_name: 'Housing', archived_at: '2026-01-01' }),
];

const TAGS = [
  { id: 1, name: 'Hawaii 2026', archived: false, txn_count: 3 },
  { id: 2, name: 'Old Trip', archived: true, txn_count: 0 },
];

const fixtures: Record<string, any> = {
  '/categories': CATEGORIES,
  '/tags': TAGS,
  '/vehicles': [{ id: 1, name: 'Civic', disposed_at: null }],
  '/properties': [{ id: 1, name: 'Home' }],
  '/subscriptions': [{ id: 1, name: 'Netflix', status: 'active' }],
};

const getImpl = (path: string) => Promise.resolve(fixtures[path] ?? {});

describe('Categories page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockImplementation((p: string) => {
      // tag report path
      if (p.startsWith('/tags/') && p.includes('/report')) {
        return Promise.resolve({
          tag: { id: 1, name: 'Hawaii 2026', description: 'Trip', archived: false },
          totals: { expense: 500, income: 100, lines: 4, first_date: '2026-01-01', last_date: '2026-02-01' },
          byCategory: [{ category_name: 'Rent', total: 300, count: 2 }, { category_name: null, total: 200, count: 2 }],
          byMonth: [{ month: '2026-01', expense: 200, income: 0 }, { month: '2026-02', expense: 300, income: 100 }],
          transactions: [{ txn_id: 9, txn_date: '2026-01-05', merchant: 'Store', direction: 'expense', account_name: 'Checking', amount: 50, category_name: 'Rent' }],
          transactions_total: 1,
        });
      }
      return getImpl(p);
    });
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    localStorage.clear();
  });

  const renderPage = () => render(<MemoryRouter><Categories /></MemoryRouter>);

  it('renders groups, items, managed groups and archived rows', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Salary Group')).toBeInTheDocument());
    expect(screen.getByText('Paycheck')).toBeInTheDocument();
    expect(screen.getByText('Housing')).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Empty Group')).toBeInTheDocument();
    // Managed group shown read-only.
    expect(screen.getByText('Electric')).toBeInTheDocument();
    expect(screen.getAllByText('Auto-managed').length).toBeGreaterThan(0);
    // Archived section.
    expect(screen.getByText('Old Category')).toBeInTheDocument();
  });

  it('shows an error when loading categories fails', async () => {
    (api.get as any).mockImplementation((p: string) =>
      p === '/categories' ? Promise.reject(new Error('load fail')) : getImpl(p));
    renderPage();
    await waitFor(() => expect(screen.getByText('load fail')).toBeInTheDocument());
  });

  it('opens the Add Group editor and creates a group', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Housing')).toBeInTheDocument());
    // The Income section "Add Group" button.
    await user.click(screen.getAllByRole('button', { name: 'Add Group' })[0]);
    expect(screen.getByText('Add Income Group')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('e.g. Utilities'), 'Bonuses');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/categories', { name: 'Bonuses', kind: 'income' }));
  });

  it('validates a blank name in the editor', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Housing')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: '+ Item' })[0]);
    // Type a whitespace-only name: it's dirty (differs from initial '') so Save is
    // enabled, but name.trim() is empty so validation fires.
    const input = screen.getByPlaceholderText('e.g. Electricity');
    await user.type(input, ' ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });

  it('adds an item to a group via + Item', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Housing')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: '+ Item' })[0]);
    expect(screen.getByText(/Add Item ·/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('e.g. Electricity'), 'Insurance');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/categories', expect.objectContaining({ name: 'Insurance' })));
  });

  it('deletes an empty group (confirmed)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Empty Group')).toBeInTheDocument());
    // The empty group has a ✕ delete button in its header.
    const emptyCard = screen.getByText('Empty Group').closest('.category-group-card')!;
    await user.click(within(emptyCard as HTMLElement).getByTitle('Delete empty group'));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/categories/20'));
  });

  it('cancels delete when not confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
    const rentRow = screen.getByText('Rent').closest('.category-item-row')!;
    await user.click(within(rentRow as HTMLElement).getByTitle('Delete'));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('inline-renames a group and commits on Enter', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Housing')).toBeInTheDocument());
    await user.click(screen.getByText('Housing'));
    const input = screen.getByDisplayValue('Housing');
    await user.clear(input);
    await user.type(input, 'Home{Enter}');
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/categories/10', { name: 'Home', parent_id: null }));
  });

  it('cancels an inline rename on Escape', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
    await user.click(screen.getByText('Rent'));
    const input = screen.getByDisplayValue('Rent');
    await user.type(input, 'zzz{Escape}');
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });

  it('restores an archived category', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Old Category')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/categories/40/archive', { archived: false }));
  });

  it('drag-reorders an item within its group', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
    const rentRow = screen.getByText('Rent').closest('.category-item-row')! as HTMLElement;
    const utilRow = screen.getByText('Utilities Bill').closest('.category-item-row')! as HTMLElement;
    fireEvent.dragStart(rentRow, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.dragOver(utilRow);
    fireEvent.drop(utilRow);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/categories/reorder', expect.objectContaining({ parent_id: 10 })));
  });

  it('drag-reorders a group', async () => {
    // Add a second expense group so there are two to reorder.
    const cats = [...CATEGORIES, cat({ id: 21, name: 'Second Group', kind: 'expense', sort_order: 2 })];
    (api.get as any).mockImplementation((p: string) => p === '/categories' ? Promise.resolve(cats) : getImpl(p));
    renderPage();
    await waitFor(() => expect(screen.getByText('Second Group')).toBeInTheDocument());
    const src = screen.getByText('Housing').closest('.category-group-card')!;
    const srcHandle = within(src as HTMLElement).getByTitle('Drag to reorder group');
    const target = screen.getByText('Second Group').closest('.category-group-card')!;
    const targetHeader = target.querySelector('.category-group-header')! as HTMLElement;
    fireEvent.dragStart(srcHandle, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.dragOver(targetHeader);
    fireEvent.drop(targetHeader);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/categories/reorder', expect.objectContaining({ parent_id: null })));
  });

  // --- Tags section ---
  it('creates a tag inline', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Hawaii 2026')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Create tag/ }));
    const input = screen.getByPlaceholderText(/Tag name/);
    await user.type(input, 'New Tag{Enter}');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tags', { name: 'New Tag' }));
  });

  it('shows and toggles archived tags, and lists auto-managed tags', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Hawaii 2026')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Show archived/ }));
    expect(screen.getByText('Old Trip')).toBeInTheDocument();
    // Auto-managed entities.
    expect(screen.getByText('Civic')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  it('navigates when clicking an auto-managed vehicle tag', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Civic')).toBeInTheDocument());
    await user.click(screen.getByText('Civic'));
    expect(navMock).toHaveBeenCalledWith('/vehicles/1');
  });

  it('opens the tag detail modal with its report and saves details', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Hawaii 2026')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Hawaii 2026/ }));
    await waitFor(() => expect(screen.getByText(/Tag · Hawaii 2026/)).toBeInTheDocument());
    // Report content.
    expect(screen.getByText('Spending by category')).toBeInTheDocument();
    expect(screen.getByText('By month')).toBeInTheDocument();
    // Edit a field to enable Save.
    const nameInput = screen.getByDisplayValue('Hawaii 2026');
    await user.type(nameInput, '!');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/tags/1', expect.objectContaining({ name: 'Hawaii 2026!' })));
  });

  it('archives a tag from the detail modal', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Hawaii 2026')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Hawaii 2026/ }));
    await waitFor(() => expect(screen.getByText(/Tag · Hawaii 2026/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/tags/1', { archived: true }));
  });
});
