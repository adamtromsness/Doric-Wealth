import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SimpleFinIntegration from './SimpleFinIntegration';

// LinkedAccounts (rendered by the manage path) hits the api on mount; a light mock
// keeps it from throwing while we exercise the gate.
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api } from '../../api';

let role = 'owner';
vi.mock('../../auth', () => ({
  useAuth: () => ({
    ready: true, user: { id: 1, email: 'a@b.com', name: 'A' },
    books: [{ id: 1, name: 'H', role }], activeBook: { id: 1, name: 'H', role },
    login: vi.fn(), register: vi.fn(), logout: vi.fn(), switchBook: vi.fn(), acceptInvite: vi.fn(), refresh: vi.fn(),
  }),
  displayName: (u: any) => u?.name ?? '',
}));

describe('SimpleFinIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockResolvedValue([]);
  });
  const renderPage = () => render(<MemoryRouter><SimpleFinIntegration /></MemoryRouter>);

  it('renders the manage UI (LinkedAccounts) for an owner', async () => {
    role = 'owner';
    renderPage();
    expect(screen.getByText('SimpleFIN')).toBeInTheDocument();
    // LinkedAccounts loads connections from the api.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText(/Only an owner or admin/)).toBeNull();
  });

  it('renders the manage UI for an admin', async () => {
    role = 'admin';
    renderPage();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText(/Only an owner or admin/)).toBeNull();
  });

  it('shows a permission notice for a member', () => {
    role = 'member';
    renderPage();
    expect(screen.getByText(/Only an owner or admin can manage bank connections/)).toBeInTheDocument();
  });
});
