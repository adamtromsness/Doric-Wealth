import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ImportSimpleFinModal } from './ImportSimpleFinModal';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api, apiStream } from '../api';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

const conns = [
  {
    id: 1, provider: 'simplefin', accounts: [
      { id: 11, account_id: 100, account_name: 'Checking', external_account_id: 'ext-1', org_name: 'Bank' },
      { id: 12, account_id: null, account_name: null, external_account_id: 'ext-2', org_name: null },
    ],
  },
];

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('ImportSimpleFinModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows loading, then the setup view with mapped accounts', async () => {
    let resolve: (v: any) => void;
    (api.get as any).mockReturnValue(new Promise((r) => { resolve = r; }));
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    resolve!(conns);
    await waitFor(() => expect(screen.getByText('Checking')).toBeInTheDocument());
    // only mapped (account_id != null) accounts appear
    expect(screen.getByText(/Import 1 Account/)).toBeInTheDocument();
  });

  it('shows the empty state when no mapped accounts exist', async () => {
    (api.get as any).mockResolvedValue([{ id: 1, provider: 'simplefin', accounts: [{ id: 12, account_id: null, account_name: null, external_account_id: 'x', org_name: null }] }]);
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No linked & mapped accounts yet/)).toBeInTheDocument());
  });

  it('surfaces a connections load error', async () => {
    (api.get as any).mockRejectedValue(new Error('conn boom'));
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText('conn boom')).toBeInTheDocument());
  });

  it('runs a streamed import and reports progress + completion', async () => {
    (api.get as any).mockResolvedValue(conns);
    (apiStream as any).mockImplementation((_path: string, _body: any, onEvent: (ev: any) => void) => {
      onEvent({ type: 'start', connections: 1 });
      onEvent({ type: 'status', message: 'Connecting…' });
      onEvent({ type: 'progress', connDone: 1, added: 3, skipped: 1, message: 'Fetched 4' });
      onEvent({ type: 'done', added: 3, skipped: 1 });
      return Promise.resolve();
    });
    const onImported = vi.fn();
    const user = userEvent.setup();
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={onImported} />);
    await waitFor(() => expect(screen.getByText(/Import 1 Account/)).toBeInTheDocument());
    await user.click(screen.getByText(/Import 1 Account/));
    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
    expect(apiStream).toHaveBeenCalledWith('/connections/import/stream', expect.objectContaining({ account_ids: [100] }), expect.any(Function));
    expect(screen.getByText(/Imported/)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();
    // Navigate to the review queue.
    await user.click(screen.getByText(/Review 3/));
    expect(navigate).toHaveBeenCalledWith('/transactions');
  });

  it('shows the nothing-new completion when only skips came back', async () => {
    (api.get as any).mockResolvedValue(conns);
    (apiStream as any).mockImplementation((_p: string, _b: any, onEvent: (ev: any) => void) => {
      onEvent({ type: 'start', connections: 1 });
      onEvent({ type: 'done', added: 0, skipped: 5 });
      return Promise.resolve();
    });
    const user = userEvent.setup();
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Import 1 Account/)).toBeInTheDocument());
    await user.click(screen.getByText(/Import 1 Account/));
    await waitFor(() => expect(screen.getByText(/Nothing new in that range/)).toBeInTheDocument());
  });

  it('surfaces a streamed error event and a thrown stream error', async () => {
    (api.get as any).mockResolvedValue(conns);
    (apiStream as any).mockImplementation((_p: string, _b: any, onEvent: (ev: any) => void) => {
      onEvent({ type: 'error', message: 'stream said no' });
      return Promise.reject(new Error('stream threw'));
    });
    const user = userEvent.setup();
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Import 1 Account/)).toBeInTheDocument());
    await user.click(screen.getByText(/Import 1 Account/));
    await waitFor(() => expect(screen.getByText('stream threw')).toBeInTheDocument());
  });

  it('lets the user deselect an account and validates an empty selection', async () => {
    (api.get as any).mockResolvedValue(conns);
    const user = userEvent.setup();
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText('Checking')).toBeInTheDocument());
    // Deselect the one mapped account via its Toggle.
    await user.click(screen.getByText('Checking'));
    // The import button becomes "Import 0 Accounts" and is disabled.
    await waitFor(() => expect(screen.getByText(/Import 0 Account/)).toBeDisabled());
  });

  it('edits the date range inputs', async () => {
    (api.get as any).mockResolvedValue(conns);
    const user = userEvent.setup();
    wrap(<ImportSimpleFinModal onClose={() => {}} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText('From')).toBeInTheDocument());
    const dates = document.querySelectorAll('input[type="date"]');
    await user.clear(dates[0] as HTMLInputElement);
    await user.type(dates[0] as HTMLInputElement, '2026-01-01');
    expect((dates[0] as HTMLInputElement).value).toBe('2026-01-01');
  });

  it('closes via Cancel from the setup view', async () => {
    (api.get as any).mockResolvedValue(conns);
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<ImportSimpleFinModal onClose={onClose} onImported={() => {}} />);
    await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument());
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
