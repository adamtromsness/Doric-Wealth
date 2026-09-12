import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth, displayName } from './auth';

// Mock the api module the provider depends on.
vi.mock('./api', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
  return { api, setUnauthorizedHandler: vi.fn() };
});
import { api, setUnauthorizedHandler } from './api';

const meFixture = {
  user: { id: 1, email: 'a@b.com', name: 'Ada', timezone: 'America/New_York' },
  books: [{ id: 1, name: 'Home', role: 'owner' }],
  activeBook: { id: 1, name: 'Home', role: 'owner' },
};

function Probe() {
  const a = useAuth();
  if (!a.ready) return <div>loading</div>;
  return (
    <div>
      <div data-testid="user">{a.user ? a.user.email : 'anon'}</div>
      <div data-testid="active">{a.activeBook?.name ?? 'none'}</div>
      <button onClick={() => a.login('a@b.com', 'pw')}>login</button>
      <button onClick={() => a.register({ email: 'n@b.com', password: 'pw' })}>register</button>
      <button onClick={() => a.logout()}>logout</button>
      <button onClick={() => a.switchBook(2)}>switch</button>
      <button onClick={() => a.acceptInvite('code 1')}>accept</button>
      <button onClick={() => a.refresh()}>refresh</button>
    </div>
  );
}

describe('displayName', () => {
  it('prefers preferred_name, then first_name, then name, then email local part', () => {
    expect(displayName({ preferred_name: 'Bee', first_name: 'Robert', name: 'X', email: 'z@z.com' })).toBe('Bee');
    expect(displayName({ first_name: 'Robert', email: 'z@z.com' })).toBe('Robert');
    expect(displayName({ name: 'Legacy', email: 'z@z.com' })).toBe('Legacy');
    expect(displayName({ email: 'zack@z.com' })).toBe('zack');
    expect(displayName(null)).toBe('');
    expect(displayName({})).toBe('');
  });
});

describe('AuthProvider', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('loads the current user on mount and registers a 401 handler', async () => {
    (api.get as any).mockResolvedValue(meFixture);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@b.com'));
    expect(screen.getByTestId('active')).toHaveTextContent('Home');
    expect(setUnauthorizedHandler).toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledWith('/auth/me');
  });

  it('falls back to anonymous when /auth/me fails', async () => {
    (api.get as any).mockRejectedValue(new Error('401'));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('anon'));
  });

  it('login/register/switchBook/acceptInvite/refresh apply the returned Me; logout clears it', async () => {
    (api.get as any).mockResolvedValue(meFixture);
    (api.post as any).mockResolvedValue(meFixture);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@b.com'));
    const user = userEvent.setup();

    await user.click(screen.getByText('login'));
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email: 'a@b.com', password: 'pw' });
    await user.click(screen.getByText('register'));
    expect(api.post).toHaveBeenCalledWith('/auth/register', { email: 'n@b.com', password: 'pw' });
    await user.click(screen.getByText('switch'));
    expect(api.post).toHaveBeenCalledWith('/books/switch', { book_id: 2 });
    await user.click(screen.getByText('accept'));
    expect(api.post).toHaveBeenCalledWith('/invites/code%201/accept');
    await user.click(screen.getByText('refresh'));

    await user.click(screen.getByText('logout'));
    expect(api.post).toHaveBeenCalledWith('/auth/logout');
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('anon'));
  });

  it('captures the browser timezone once when the user has none set', async () => {
    (api.get as any).mockResolvedValue({ ...meFixture, user: { ...meFixture.user, timezone: null } });
    (api.put as any).mockResolvedValue({});
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/profile', expect.objectContaining({ timezone: expect.any(String) })));
  });

  it('useAuth throws outside a provider', () => {
    const Bad = () => { useAuth(); return null; };
    // Silence the expected React error boundary log.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow('useAuth must be used within AuthProvider');
    spy.mockRestore();
  });
});
