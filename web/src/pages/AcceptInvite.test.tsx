import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AcceptInvite from './AcceptInvite';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

const acceptInvite = vi.fn();
let authUser: any = null;
vi.mock('../auth', () => ({
  useAuth: () => ({ user: authUser, acceptInvite }),
  displayName: (u: any) => u?.name ?? '',
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/accept" element={<AcceptInvite />} />
        <Route path="/" element={<div>home page</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('AcceptInvite page', () => {
  beforeEach(() => {
    acceptInvite.mockReset();
    authUser = null;
    (api.get as any).mockResolvedValue({ book_name: 'Home Books', role: 'member' });
  });

  it('shows an error and skips the request when no code is present', async () => {
    renderAt('/accept');
    expect(await screen.findByText('No invite code provided.')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('previews the invite and offers auth links when logged out', async () => {
    renderAt('/accept?code=abc');
    expect(await screen.findByText('Home Books')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/invites/abc');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?code=abc');
    expect(screen.getByRole('link', { name: 'create an account' })).toHaveAttribute('href', '/register?code=abc');
  });

  it('shows a preview-fetch error', async () => {
    (api.get as any).mockRejectedValue(new Error('invite expired'));
    renderAt('/accept?code=abc');
    expect(await screen.findByText('invite expired')).toBeInTheDocument();
  });

  it('lets a logged-in user join, then navigates home', async () => {
    authUser = { id: 1, email: 'a@b.com', name: 'Ada' };
    acceptInvite.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt('/accept?code=abc');
    expect(await screen.findByText('Join Shared Books')).toBeInTheDocument();
    // The button label carries the fetched book name, which lands after the heading.
    await user.click(await screen.findByRole('button', { name: 'Join Home Books' }));
    expect(acceptInvite).toHaveBeenCalledWith('abc');
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });

  it('shows a join error for a logged-in user', async () => {
    authUser = { id: 1, email: 'a@b.com', name: 'Ada' };
    acceptInvite.mockRejectedValue(new Error('already a member'));
    const user = userEvent.setup();
    renderAt('/accept?code=abc');
    await screen.findByRole('button', { name: 'Join Home Books' });
    await user.click(screen.getByRole('button', { name: 'Join Home Books' }));
    await waitFor(() => expect(screen.getByText('already a member')).toBeInTheDocument());
  });
});
