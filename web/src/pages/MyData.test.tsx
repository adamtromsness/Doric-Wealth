import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import MyData from './MyData';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiDownload: vi.fn(),
    apiBlob: vi.fn(),
    apiStream: vi.fn(),
  };
});
import { api, apiDownload } from '../api';

vi.mock('../auth', () => ({
  useAuth: () => ({ activeBook: { id: 1, name: 'Home', role: 'owner' } }),
  displayName: (u: any) => u?.name ?? '',
}));

const groups = [
  { key: 'transactions', label: 'Transactions', rows: 100, bytes: 5000 },
  { key: 'accounts', label: 'Accounts', rows: 10, bytes: 2000 },
];
const sched = { enabled: false, frequency: 'daily', start_at: null, groups: null, last_backup_at: null };
const snaps = [
  { id: 1, created_at: '2026-03-01T10:00:00Z', taken_at: '2026-03-01T10:00:00Z', name: 'My Snap', label: 'manual', scope: 'full', pinned: false, bytes: 4096 },
];

const buildFixtures = (over: Record<string, any> = {}) => ({
  '/backup/groups': groups,
  '/backup/schedule': sched,
  '/backup/snapshots': { snapshots: snaps, max: 5 },
  ...over,
});

let fixtures: Record<string, any>;

const renderPage = () => render(<MemoryRouter><MyData /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fixtures = buildFixtures();
  (api.get as any).mockImplementation((path: string) => Promise.resolve(fixtures[path] ?? {}));
  (api.post as any).mockResolvedValue({});
  (api.patch as any).mockResolvedValue({});
  (api.del as any).mockResolvedValue(undefined);
  (apiDownload as any).mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe('MyData — overview tab', () => {
  it('renders totals and the per-data-set size table', async () => {
    renderPage();
    expect(await screen.findByText('My Data')).toBeInTheDocument();
    expect(screen.getByText('110')).toBeInTheDocument(); // total records
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
  });

  it('shows a groups-load error', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/backup/groups' ? Promise.reject(new Error('groups boom')) : Promise.resolve({}));
    renderPage();
    expect(await screen.findByText('groups boom')).toBeInTheDocument();
  });

  it('shows an empty overview when there are no groups', async () => {
    fixtures = buildFixtures({ '/backup/groups': [] });
    renderPage();
    expect(await screen.findByText('No data to summarize yet.')).toBeInTheDocument();
  });
});

describe('MyData — snapshots tab', () => {
  const goSnapshots = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText('My Data');
    await user.click(screen.getByRole('button', { name: 'Snapshots' }));
  };

  it('lists snapshots and creates a new one', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    expect(screen.getByDisplayValue('My Snap')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Name (optional)'), 'Backup A');
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/snapshots', { name: 'Backup A', groups: null }));
    expect(await screen.findByText('Snapshot created.')).toBeInTheDocument();
  });

  it('creates a partial snapshot when not all data sets are selected', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByRole('button', { name: 'Select None' }));
    // Select just Transactions via its toggle label.
    await user.click(screen.getByText('Transactions'));
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/snapshots', { name: undefined, groups: ['transactions'] }));
  });

  it('surfaces a create error', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/snapshots' ? Promise.reject(new Error('create failed')) : Promise.resolve({}));
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    expect(await screen.findByText('create failed')).toBeInTheDocument();
  });

  it('disables Create Now with nothing selected', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByRole('button', { name: 'Select None' }));
    expect(screen.getByRole('button', { name: 'Create Now' })).toBeDisabled();
  });

  it('deletes a snapshot', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/backup/snapshots/1'));
    await waitFor(() => expect(screen.queryByDisplayValue('My Snap')).toBeNull());
  });

  it('downloads a snapshot', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith(
      '/backup/snapshots/1/download', expect.stringContaining('ledger-my-snap-'),
    ));
  });

  it('renames a snapshot on blur', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    const nameInput = screen.getByDisplayValue('My Snap');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.tab();
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/backup/snapshots/1', { name: 'Renamed' }));
  });

  it('surfaces a rename error', async () => {
    (api.patch as any).mockRejectedValue(new Error('rename failed'));
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    const nameInput = screen.getByDisplayValue('My Snap');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.tab();
    expect(await screen.findByText('rename failed')).toBeInTheDocument();
  });

  it('pins a snapshot and reports an auto-unpin', async () => {
    (api.patch as any).mockResolvedValue({ unpinned: ['Old One'] });
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    // The pin toggle is the only checkbox-like Toggle in the snapshot row area besides schedule ones.
    const keepCell = screen.getByDisplayValue('My Snap').closest('tr')!;
    fireEvent.click(within(keepCell).getByRole('checkbox'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/backup/snapshots/1', { pinned: true }));
    expect(await screen.findByText(/You can keep at most 4 snapshots/)).toBeInTheDocument();
  });

  it('shows an empty snapshot state', async () => {
    fixtures = buildFixtures({ '/backup/snapshots': { snapshots: [], max: 5 } });
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    expect(screen.getByText(/No snapshots yet/)).toBeInTheDocument();
  });

  it('toggles the schedule and saves it', async () => {
    (api.post as any).mockResolvedValue({ ...sched, enabled: true });
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    // The "Automatic Backups" toggle -> makes settings dirty.
    const autoLabel = screen.getByText('Off');
    await user.click(autoLabel);
    const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.click(saveBtn);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/schedule', expect.objectContaining({ enabled: true })));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('surfaces a schedule save error', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/schedule' ? Promise.reject(new Error('sched failed')) : Promise.resolve({}));
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByText('Off'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('sched failed')).toBeInTheDocument();
  });

  it('Save Changes is disabled until settings are dirty', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('shows the non-Chromium fallback when the FS API is unavailable', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    // jsdom has no showDirectoryPicker → fallback message.
    expect(screen.getByText(/needs a Chromium browser/)).toBeInTheDocument();
  });

  describe('upload', () => {
    it('uploads a snapshot file and adds it to the list', async () => {
      const user = userEvent.setup();
      renderPage();
      await goSnapshots(user);
      const file = new File([JSON.stringify({ tables: {} })], 'backup.json', { type: 'application/json' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, file);
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/snapshots/upload', expect.objectContaining({ name: 'backup' })));
      expect(await screen.findByText('Snapshot added to the list.')).toBeInTheDocument();
    });

    it('rejects a file that is too large', async () => {
      const user = userEvent.setup();
      renderPage();
      await goSnapshots(user);
      const big = new File(['x'], 'big.json', { type: 'application/json' });
      Object.defineProperty(big, 'size', { value: 201 * 1024 * 1024 });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, big);
      expect(await screen.findByText(/too large/)).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalledWith('/backup/snapshots/upload', expect.anything());
    });
  });

  describe('restore flow', () => {
    it('previews and restores a snapshot with the REPLACE confirmation', async () => {
      const preview = {
        book: { id: 1, name: 'Home' }, exported_at: '2026-03-01T10:00:00Z',
        schema_version: 3, schema_mismatch: false, total_rows: 42,
        counts: { transactions: 40, accounts: 2 },
      };
      (api.post as any).mockImplementation((path: string) => {
        if (path === '/backup/snapshots/1/preview') return Promise.resolve(preview);
        if (path === '/backup/snapshots/1/restore') return Promise.resolve({ restored_rows: 42 });
        return Promise.resolve({});
      });
      const user = userEvent.setup();
      renderPage();
      await goSnapshots(user);
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText(/Restore from/)).toBeInTheDocument();
      expect(screen.getByText(/42 records/)).toBeInTheDocument();

      const confirm = screen.getByPlaceholderText('REPLACE');
      expect(screen.getByRole('button', { name: 'Replace Data' })).toBeDisabled();
      await user.type(confirm, 'REPLACE');
      await user.click(screen.getByRole('button', { name: 'Replace Data' }));
      await waitFor(() => expect(apiDownload).toHaveBeenCalledWith(
        expect.stringContaining('/backup/export?label=pre-restore'), expect.any(String)));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/snapshots/1/restore', { confirm: 'REPLACE' }));
      expect(await screen.findByText(/Restore complete/)).toBeInTheDocument();
    });

    it('warns on a schema mismatch and can cancel', async () => {
      const preview = {
        book: null, exported_at: null, schema_version: 1, schema_mismatch: true,
        total_rows: 5, counts: {},
      };
      (api.post as any).mockImplementation((path: string) =>
        path === '/backup/snapshots/1/preview' ? Promise.resolve(preview) : Promise.resolve({}));
      const user = userEvent.setup();
      renderPage();
      await goSnapshots(user);
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText(/different app version/)).toBeInTheDocument();
      await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
      await waitFor(() => expect(screen.queryByText(/Restore from/)).toBeNull());
    });

    it('aborts the restore if the safety snapshot download fails', async () => {
      const preview = { book: null, exported_at: null, schema_version: 1, schema_mismatch: false, total_rows: 1, counts: {} };
      (api.post as any).mockImplementation((path: string) =>
        path === '/backup/snapshots/1/preview' ? Promise.resolve(preview) : Promise.resolve({}));
      (apiDownload as any).mockRejectedValue(new Error('disk full'));
      const user = userEvent.setup();
      renderPage();
      await goSnapshots(user);
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      await screen.findByPlaceholderText('REPLACE');
      await user.type(screen.getByPlaceholderText('REPLACE'), 'REPLACE');
      await user.click(screen.getByRole('button', { name: 'Replace Data' }));
      expect(await screen.findByText(/the restore was cancelled/)).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalledWith('/backup/snapshots/1/restore', expect.anything());
    });

    it('surfaces a preview error', async () => {
      (api.post as any).mockImplementation((path: string) =>
        path === '/backup/snapshots/1/preview' ? Promise.reject(new Error('preview boom')) : Promise.resolve({}));
      const user = userEvent.setup();
      renderPage();
      await goSnapshots(user);
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText('preview boom')).toBeInTheDocument();
    });
  });
});

describe('MyData — purge tab', () => {
  const goPurge = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText('My Data');
    await user.click(screen.getByRole('button', { name: 'Purge Data' }));
  };

  it('previews then deletes selected data with the DELETE confirmation', async () => {
    (api.post as any).mockImplementation((path: string) => {
      if (path === '/backup/purge/preview') return Promise.resolve({ groups: [{ key: 'transactions', label: 'Transactions', rows: 3 }], total_rows: 3 });
      if (path === '/backup/purge') return Promise.resolve({ deleted_rows: 3 });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage();
    await goPurge(user);
    expect(screen.getByRole('button', { name: 'Preview Deletion' })).toBeDisabled();
    await user.click(screen.getByText('Transactions'));
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/purge/preview', expect.objectContaining({ groups: ['transactions'] })));
    expect(await screen.findByText('Staged for deletion')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.click(screen.getByRole('button', { name: /Delete 3 Records/ }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith(
      expect.stringContaining('label=pre-delete'), expect.any(String)));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/purge', expect.objectContaining({ confirm: 'DELETE' })));
    expect(await screen.findByText(/Deleted 3 records/)).toBeInTheDocument();
  });

  it('shows a nothing-to-delete preview', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/purge/preview' ? Promise.resolve({ groups: [], total_rows: 0 }) : Promise.resolve({}));
    const user = userEvent.setup();
    renderPage();
    await goPurge(user);
    await user.click(screen.getByText('Transactions'));
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    expect(await screen.findByText(/nothing to delete/)).toBeInTheDocument();
  });

  it('Select All then a date change invalidates the staged preview', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/purge/preview' ? Promise.resolve({ groups: [{ key: 'transactions', label: 'Transactions', rows: 3 }], total_rows: 3 }) : Promise.resolve({}));
    const user = userEvent.setup();
    renderPage();
    await goPurge(user);
    await user.click(screen.getByRole('button', { name: 'Select All' }));
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    expect(await screen.findByText('Staged for deletion')).toBeInTheDocument();
    // Changing the From date resets the preview.
    const from = screen.getByLabelText('From');
    await user.type(from, '2026-01-01');
    await waitFor(() => expect(screen.queryByText('Staged for deletion')).toBeNull());
  });

  it('surfaces a preview error', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/purge/preview' ? Promise.reject(new Error('purge preview boom')) : Promise.resolve({}));
    const user = userEvent.setup();
    renderPage();
    await goPurge(user);
    await user.click(screen.getByText('Transactions'));
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    expect(await screen.findByText('purge preview boom')).toBeInTheDocument();
  });

  it('aborts the delete if the safety snapshot download fails', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/purge/preview' ? Promise.resolve({ groups: [{ key: 'transactions', label: 'Transactions', rows: 3 }], total_rows: 3 }) : Promise.resolve({}));
    (apiDownload as any).mockRejectedValue(new Error('disk full'));
    const user = userEvent.setup();
    renderPage();
    await goPurge(user);
    await user.click(screen.getByText('Transactions'));
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    await screen.findByPlaceholderText('DELETE');
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.click(screen.getByRole('button', { name: /Delete 3 Records/ }));
    expect(await screen.findByText(/the delete was cancelled/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/backup/purge', expect.anything());
  });

  it('cancels a staged purge', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/backup/purge/preview' ? Promise.resolve({ groups: [{ key: 'transactions', label: 'Transactions', rows: 3 }], total_rows: 3 }) : Promise.resolve({}));
    const user = userEvent.setup();
    renderPage();
    await goPurge(user);
    await user.click(screen.getByText('Transactions'));
    await user.click(screen.getByRole('button', { name: 'Preview Deletion' }));
    await screen.findByText('Staged for deletion');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Staged for deletion')).toBeNull());
  });
});
