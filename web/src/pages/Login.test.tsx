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
  beforeEach(() => { login.mockReset(); });

  it('renders the sign-in form', () => {
    renderAt();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Welcome back to Doric.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register');
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
