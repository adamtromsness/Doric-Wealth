import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// The FS-support flag and idb globals are read at module import time, so install a
// minimal in-memory IndexedDB + showDirectoryPicker BEFORE MyData is imported.
// `vi.hoisted` runs before the (hoisted) import statements.
const fs = vi.hoisted(() => {
  class FakeRequest {
    result: any = undefined; error: any = null;
    onsuccess: (() => void) | null = null; onerror: (() => void) | null = null;
    onupgradeneeded: (() => void) | null = null;
    _succeed(v: any) { this.result = v; queueMicrotask(() => this.onsuccess?.()); }
  }
  const store = new Map<string, any>();
  class FakeObjectStore {
    put(v: any, k: string) { store.set(k, v); const r = new FakeRequest(); r._succeed(undefined); return r; }
    get(k: string) { const r = new FakeRequest(); r._succeed(store.get(k)); return r; }
  }
  class FakeTx {
    oncomplete: (() => void) | null = null; onerror: (() => void) | null = null; error: any = null;
    objectStore() { const os = new FakeObjectStore(); queueMicrotask(() => this.oncomplete?.()); return os; }
  }
  const fakeDb = { createObjectStore: () => {}, transaction: () => new FakeTx() };
  (globalThis as any).indexedDB = {
    open: () => {
      const r = new FakeRequest();
      r.result = fakeDb;
      queueMicrotask(() => { r.onupgradeneeded?.(); r.onsuccess?.(); });
      return r;
    },
  };
  (globalThis as any).showDirectoryPicker = () => Promise.resolve(undefined);
  (globalThis as any).window && ((globalThis as any).window.showDirectoryPicker = (globalThis as any).showDirectoryPicker);
  return { store };
});
const { store } = fs;

// A directory handle stub with granted permissions and a couple of stored files.
const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
const makeHandle = (name = 'Backups', existing: string[] = []) => ({
  name,
  queryPermission: vi.fn().mockResolvedValue('granted'),
  requestPermission: vi.fn().mockResolvedValue('granted'),
  keys: async function* () { for (const k of existing) yield k; },
  getFileHandle: vi.fn().mockResolvedValue({ createWritable: () => Promise.resolve(writable) }),
});
let pickedHandle = makeHandle();
(window as any).showDirectoryPicker = vi.fn(() => Promise.resolve(pickedHandle));

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
import { api, apiBlob } from '../api';

vi.mock('../auth', () => ({
  useAuth: () => ({ activeBook: { id: 1, name: 'Home', role: 'owner' } }),
  displayName: (u: any) => u?.name ?? '',
}));

// Import AFTER the FS globals are installed (module-level fsSupported captures them).
import MyData from './MyData';

const groups = [{ key: 'transactions', label: 'Transactions', rows: 100, bytes: 5000 }];
const sched = { enabled: false, frequency: 'daily', start_at: null, groups: null, last_backup_at: null };
const snaps = [
  { id: 1, created_at: '2026-03-01T10:00:00Z', taken_at: '2026-03-01T10:00:00Z', name: 'Snap One', label: 'manual', scope: 'full', pinned: false, bytes: 4096 },
];
const fixtures: Record<string, any> = {
  '/backup/groups': groups,
  '/backup/schedule': sched,
  '/backup/snapshots': { snapshots: snaps, max: 5 },
};

const renderPage = () => render(<MemoryRouter><MyData /></MemoryRouter>);
const goSnapshots = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByText('My Data');
  await user.click(screen.getByRole('button', { name: 'Snapshots' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  store.clear();
  writable.write.mockClear(); writable.close.mockClear();
  pickedHandle = makeHandle();
  (window as any).showDirectoryPicker = vi.fn(() => Promise.resolve(pickedHandle));
  (api.get as any).mockImplementation((path: string) => Promise.resolve(fixtures[path] ?? {}));
  (api.post as any).mockResolvedValue({});
  (api.patch as any).mockResolvedValue({});
  (api.del as any).mockResolvedValue(undefined);
  (apiBlob as any).mockResolvedValue(new Blob(['{}'], { type: 'application/json' }));
});

afterEach(() => vi.clearAllMocks());

describe('MyData — File System Access (folder auto-save)', () => {
  it('shows the Chromium folder controls when the FS API is supported', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    expect(screen.getByText('Automatically Save Snapshots to a Folder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Folder' })).toBeDisabled(); // until auto-save on
  });

  it('enabling auto-save picks a folder, and Save persists the folder settings', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    // Toggle auto-save on → prompts folder picker.
    await user.click(screen.getByText('Automatically Save Snapshots to a Folder'));
    await waitFor(() => expect((window as any).showDirectoryPicker).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Backups')).toBeInTheDocument());
    // Now settings are dirty → Save Changes commits to localStorage + IndexedDB.
    const save = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(localStorage.getItem('snapAutoSave')).toBe('1'));
    await waitFor(() => expect(store.get('snapDir')).toBeTruthy());
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('saves all snapshots to the chosen folder immediately', async () => {
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByText('Automatically Save Snapshots to a Folder'));
    await waitFor(() => expect(screen.getByText('Backups')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save Snapshots Now' }));
    // One snapshot not yet on disk → written once.
    await waitFor(() => expect(apiBlob).toHaveBeenCalledWith('/backup/snapshots/1/download'));
    await waitFor(() => expect(writable.write).toHaveBeenCalled());
    expect(await screen.findByText(/Saved 1 snapshot/)).toBeInTheDocument();
  });

  it('reports "already up to date" when the folder already has the snapshot', async () => {
    pickedHandle = makeHandle('Backups', ['ledger-snap-one-2026-03-01--id1.json']);
    (window as any).showDirectoryPicker = vi.fn(() => Promise.resolve(pickedHandle));
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByText('Automatically Save Snapshots to a Folder'));
    await waitFor(() => expect(screen.getByText('Backups')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save Snapshots Now' }));
    expect(await screen.findByText(/already up to date/)).toBeInTheDocument();
    expect(writable.write).not.toHaveBeenCalled();
  });

  it('surfaces a denied write permission when saving', async () => {
    pickedHandle = makeHandle();
    pickedHandle.queryPermission = vi.fn().mockResolvedValue('prompt');
    pickedHandle.requestPermission = vi.fn().mockResolvedValue('denied');
    (window as any).showDirectoryPicker = vi.fn(() => Promise.resolve(pickedHandle));
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    // Enabling auto-save calls chooseFolder, which denies → error.
    await user.click(screen.getByText('Automatically Save Snapshots to a Folder'));
    expect(await screen.findByText(/Permission to write to that folder was denied/)).toBeInTheDocument();
  });

  it('ignores an AbortError when the folder picker is dismissed', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    (window as any).showDirectoryPicker = vi.fn(() => Promise.reject(abort));
    const user = userEvent.setup();
    renderPage();
    await goSnapshots(user);
    await user.click(screen.getByText('Automatically Save Snapshots to a Folder'));
    // No error banner for a user-cancelled picker.
    await waitFor(() => expect((window as any).showDirectoryPicker).toHaveBeenCalled());
    expect(screen.queryByText(/Could not open that folder/)).toBeNull();
  });
});
