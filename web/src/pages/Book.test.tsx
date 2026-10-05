import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Book from './Book';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

const refresh = vi.fn();
let activeBook: any;
let authUser: any = { id: 1 };
vi.mock('../auth', () => ({
  useAuth: () => ({ user: authUser, activeBook, refresh }),
  displayName: (u: any) => u?.name ?? '',
}));

const members = [
  { id: 1, email: 'ada@b.com', name: 'Ada', role: 'owner', created_at: '2026-01-01', last_login_at: '2026-02-01' },
  { id: 2, email: 'bo@b.com', name: null, role: 'member', created_at: '2026-01-02', last_login_at: null },
];
const invites = [
  { id: 7, code: 'inv7', role: 'member', url: '/accept?code=inv7', expires_at: null, max_uses: 3, uses: 1 },
];

const fixtures: Record<string, any> = {
  '/books/1/members': members,
  '/books/1/invites': invites,
};

const renderPage = () => render(<MemoryRouter><Book /></MemoryRouter>);

describe('Book page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeBook = { id: 1, name: 'Home', role: 'owner' };
    authUser = { id: 1 };
    (api.get as any).mockImplementation((path: string) => Promise.resolve(fixtures[path] ?? []));
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue(undefined);
  });

  it('renders the members table and management sections for an owner', async () => {
    renderPage();
    expect(await screen.findByText('ada@b.com')).toBeInTheDocument();
    expect(screen.getByText('bo@b.com')).toBeInTheDocument();
    expect(screen.getByText('Books name')).toBeInTheDocument();
    expect(screen.getByText('Invite user')).toBeInTheDocument();
    expect(screen.getByText('Start another set of books')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/books/1/members');
    expect(api.get).toHaveBeenCalledWith('/books/1/invites');
  });

  it('shows a members load error', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/books/1/members' ? Promise.reject(new Error('members boom')) : Promise.resolve([]));
    renderPage();
    expect(await screen.findByText('members boom')).toBeInTheDocument();
  });

  it('hides management sections and skips invites for a plain member', async () => {
    activeBook = { id: 1, name: 'Home', role: 'member' };
    renderPage();
    await screen.findByText('ada@b.com');
    expect(screen.queryByText('Books name')).toBeNull();
    expect(screen.queryByText('Invite user')).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith('/books/1/invites');
  });

  it('renames the books', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ada@b.com');
    const input = screen.getByPlaceholderText('e.g. Home Books');
    await user.type(input, ' Redux');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/books/1', { name: 'Home Redux' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('surfaces a rename error', async () => {
    (api.put as any).mockRejectedValue(new Error('rename failed'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ada@b.com');
    await user.type(screen.getByPlaceholderText('e.g. Home Books'), 'X');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('rename failed')).toBeInTheDocument();
  });

  it('creates a new invite link', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ada@b.com');
    await user.click(screen.getByRole('button', { name: 'New Invite Link' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/books/1/invites', {}));
  });

  it('shows an empty invites state', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/books/1/invites' ? Promise.resolve([]) : Promise.resolve(members));
    renderPage();
    expect(await screen.findByText('No active invites. Create a link to share.')).toBeInTheDocument();
  });

  it('lists invites with a copy and revoke action', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await screen.findByText('ada@b.com');
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/accept?code=inv7`);
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/books/1/invites/7'));
  });

  it('surfaces a revoke error', async () => {
    (api.del as any).mockRejectedValue(new Error('revoke failed'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ada@b.com');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('revoke failed')).toBeInTheDocument();
  });

  it('creates another set of books', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ada@b.com');
    const input = screen.getByPlaceholderText("e.g. Mom & Dad's books");
    await user.type(input, 'Rental');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/books', { name: 'Rental' }));
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('surfaces a create-books error', async () => {
    (api.post as any).mockRejectedValue(new Error('create failed'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ada@b.com');
    await user.type(screen.getByPlaceholderText("e.g. Mom & Dad's books"), 'Rental');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('create failed')).toBeInTheDocument();
  });

  it('renders a fallback title when there is no active book', async () => {
    activeBook = undefined;
    renderPage();
    await waitFor(() => expect(screen.getByText('Books')).toBeInTheDocument());
  });

  describe('removing members and invite limits', () => {
    const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

    it('an owner can remove a member (after confirming); the last owner has no button', async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderPage();
      await screen.findByText('bo@b.com');
      expect(within(rowOf('ada@b.com')).queryByRole('button')).toBeNull(); // only owner: can't leave
      await user.click(within(rowOf('bo@b.com')).getByRole('button', { name: 'Remove' }));
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Remove bo@b.com from Home\? They'll lose access right away\./));
      expect(api.del).toHaveBeenCalledWith('/books/1/members/2');
      confirmSpy.mockRestore();
    });

    it('does nothing when the removal is not confirmed', async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderPage();
      await screen.findByText('bo@b.com');
      await user.click(within(rowOf('bo@b.com')).getByRole('button', { name: 'Remove' }));
      expect(api.del).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('a member sees only a Leave button on their own row, and leaving refreshes', async () => {
      const user = userEvent.setup();
      activeBook = { id: 1, name: 'Home', role: 'member' };
      authUser = { id: 2 };
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderPage();
      await screen.findByText('bo@b.com');
      expect(within(rowOf('ada@b.com')).queryByRole('button')).toBeNull();
      await user.click(within(rowOf('bo@b.com')).getByRole('button', { name: 'Leave' }));
      expect(api.del).toHaveBeenCalledWith('/books/1/members/2');
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      confirmSpy.mockRestore();
    });

    it('shows a removal error', async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      (api.del as any).mockRejectedValue(new Error("That's the only owner of these books, so they can't be removed."));
      renderPage();
      await screen.findByText('bo@b.com');
      await user.click(within(rowOf('bo@b.com')).getByRole('button', { name: 'Remove' }));
      expect(await screen.findByText(/only owner of these books/)).toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it('invites show their use limit and expiry, and explain the defaults', async () => {
      fixtures['/books/1/invites'] = [{ ...invites[0], max_uses: 1, uses: 0, expires_at: '2026-10-12T17:00:00Z' }];
      renderPage();
      expect(await screen.findByText('0 / 1')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Expires' })).toBeInTheDocument();
      expect(screen.getByText('Oct 12, 2026')).toBeInTheDocument();
      expect(screen.getByText(/Each link works once and expires after 7 days/)).toBeInTheDocument();
      fixtures['/books/1/invites'] = invites;
    });
  });
});
