import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EntityMaintenance } from './EntityMaintenance';

// NOTE: EntityMaintenance defines its `Editor`/`Table` as inner components, so they
// remount on every parent re-render (each keystroke). userEvent.type loses focus
// mid-word; we drive controlled inputs with fireEvent.change (one render per set)
// and re-query elements after each change.
const itemInput = () => screen.getByPlaceholderText('e.g. Annual service, engine overhaul') as HTMLInputElement;

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const BASE = '/assets/5';

const rows = [
  { id: 1, item: 'Annual service', status: 'upcoming', service_date: null, cost: null, due_date: '2026-12-01', vendor: 'Shop', notes: 'soon' },
  { id: 2, item: 'Engine overhaul', status: 'completed', service_date: '2026-02-01', cost: 1200, due_date: null, vendor: 'Garage', notes: null },
];

const setList = (list: any[]) =>
  (api.get as any).mockImplementation((path: string) =>
    path === `${BASE}/maintenance` ? Promise.resolve(list) : Promise.resolve([]));

const renderPage = () => render(<MemoryRouter><EntityMaintenance basePath={BASE} /></MemoryRouter>);

describe('EntityMaintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows empty states for both sections', async () => {
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No upcoming maintenance scheduled.')).toBeInTheDocument());
    expect(screen.getByText('No service history yet.')).toBeInTheDocument();
  });

  it('renders upcoming and completed rows', async () => {
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Annual service')).toBeInTheDocument());
    expect(screen.getByText('Engine overhaul')).toBeInTheDocument();
    expect(screen.getByText('Shop')).toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.getByText(/soon/)).toBeInTheDocument();
  });

  it('validates and adds an upcoming item, toggling status', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No upcoming maintenance scheduled.')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Upcoming' }));
    // blank -> validation
    await user.click(screen.getByRole('button', { name: 'Add Item' }));
    expect(screen.getByText('Item is required.')).toBeInTheDocument();

    fireEvent.change(itemInput(), { target: { value: 'Tire rotation' } });
    // status starts as 'upcoming' -> Due Date shown; switch to completed -> Service Date
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } });
    expect(screen.getByText('Service Date')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'upcoming' } });
    expect(screen.getByText('Due Date')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add Item' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/maintenance`, expect.objectContaining({ item: 'Tire rotation', status: 'upcoming' })));
  });

  it('adds a completed item via Add Completed', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No service history yet.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Completed' }));
    // preset status = completed -> Service Date visible
    expect(screen.getByText('Service Date')).toBeInTheDocument();
    fireEvent.change(itemInput(), { target: { value: 'Oil change' } });
    await user.click(screen.getByRole('button', { name: 'Add Item' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/maintenance`, expect.objectContaining({ item: 'Oil change', status: 'completed' })));
  });

  it('edits an existing item', async () => {
    const user = userEvent.setup();
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Annual service')).toBeInTheDocument());

    await user.click(screen.getAllByTitle('Edit')[0]);
    expect(itemInput().value).toBe('Annual service');
    fireEvent.change(itemInput(), { target: { value: 'Annual service v2' } });
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${BASE}/maintenance/1`, expect.objectContaining({ item: 'Annual service v2' })));
  });

  it('cancels the editor', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No upcoming maintenance scheduled.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Upcoming' }));
    expect(screen.getByPlaceholderText('e.g. Annual service, engine overhaul')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('e.g. Annual service, engine overhaul')).toBeNull();
  });

  it('deletes when confirmed and skips when cancelled', async () => {
    const user = userEvent.setup();
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Annual service')).toBeInTheDocument());

    (window.confirm as any).mockReturnValueOnce(false);
    await user.click(screen.getAllByTitle('Delete')[0]);
    expect(api.del).not.toHaveBeenCalled();

    await user.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(`${BASE}/maintenance/1`));
  });

  it('surfaces an error when saving fails', async () => {
    const user = userEvent.setup();
    setList([]);
    (api.post as any).mockRejectedValueOnce(new Error('maint boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('No upcoming maintenance scheduled.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Upcoming' }));
    fireEvent.change(itemInput(), { target: { value: 'X' } });
    await user.click(screen.getByRole('button', { name: 'Add Item' }));
    await waitFor(() => expect(screen.getByText('maint boom')).toBeInTheDocument());
  });
});
