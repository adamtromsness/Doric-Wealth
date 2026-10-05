import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Login from './Login';

const login = vi.fn();
vi.mock('../auth', () => ({
  useAuth: () => ({ login }),
  displayName: (u: any) => u?.name ?? '',
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';
const signupConfig = (invite_only: boolean, first_account = false) =>
  (api.get as any).mockResolvedValue({ invite_only, first_account });

const renderAt = (path = '/login') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>home page</div>} />
        <Route path="/accept" element={<div>accept page</div>} />
        <Route path="/register" element={<div>register page</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('Login page', () => {
  beforeEach(() => { login.mockReset(); signupConfig(false); });

  it('renders the sign-in form', () => {
    renderAt();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Welcome back to Doric.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register');
  });

  it('invite-only: the sign-up link says to use an invite', async () => {
    signupConfig(true);
    renderAt();
    expect(await screen.findByRole('link', { name: 'Create your account' })).toHaveAttribute('href', '/register');
    expect(screen.getByText(/Have an invite\?/)).toBeInTheDocument();
  });

  it('invite-only but empty database: the normal sign-up link', async () => {
    signupConfig(true, true);
    renderAt();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/signup-config'));
    expect(screen.getByRole('link', { name: 'Create one' })).toBeInTheDocument();
  });

  it('links to Forgot password?', () => {
    renderAt();
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
  });

  it('submits credentials and navigates home on success', async () => {
    login.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt();
    await user.type(container.querySelector('input[type="email"]')!, 'a@b.com');
    await user.type(container.querySelector('input[type="password"]')!, 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledWith('a@b.com', 'pw');
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });

  it('shows an error message when login fails', async () => {
    login.mockRejectedValue(new Error('bad creds'));
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('bad creds')).toBeInTheDocument());
  });

  it('carries an invite code through the links and post-login redirect', async () => {
    login.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt('/login?code=abc%20123');
    expect(screen.getByRole('link', { name: 'Create one' }))
      .toHaveAttribute('href', '/register?code=abc%20123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('accept page')).toBeInTheDocument());
  });
});
