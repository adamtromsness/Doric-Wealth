import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

describe('ForgotPassword', () => {
  beforeEach(() => vi.clearAllMocks());
  const send = async (email_enabled: boolean) => {
    (api.post as any).mockResolvedValue({ ok: true, email_enabled });
    const user = userEvent.setup();
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    await user.type(document.querySelector('input[type="email"]')!, 'pat@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Reset Link' }));
    expect(api.post).toHaveBeenCalledWith('/auth/password-reset/request', { email: 'pat@example.com' });
  };

  it('with email set up: says a link was sent if the account exists', async () => {
    await send(true);
    expect(await screen.findByText(/we've sent it a link to reset the password/)).toBeInTheDocument();
  });

  it('without email: says to ask the person who runs Doric', async () => {
    await send(false);
    expect(await screen.findByText(/Ask the person who runs Doric/)).toBeInTheDocument();
  });

  it('shows an error', async () => {
    (api.post as any).mockRejectedValue(new Error('Too many password reset attempts.'));
    const user = userEvent.setup();
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    await user.type(document.querySelector('input[type="email"]')!, 'pat@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Reset Link' }));
    expect(await screen.findByText('Too many password reset attempts.')).toBeInTheDocument();
  });
});

describe('ResetPassword', () => {
  beforeEach(() => vi.clearAllMocks());
  const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><ResetPassword /></MemoryRouter>);

  it('checks the link, validates the new password, and saves it', async () => {
    (api.get as any).mockResolvedValue({ email: 'pa••@example.com' });
    (api.post as any).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderAt('/reset-password?token=abc123');
    expect(await screen.findByText('For pa••@example.com.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/auth/password-reset/abc123');
    const [pw, pw2] = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];

    await user.type(pw, 'short');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument();

    await user.clear(pw); await user.type(pw, 'new-password-1'); await user.type(pw2, 'different-1');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.clear(pw2); await user.type(pw2, 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));
    expect(api.post).toHaveBeenCalledWith('/auth/password-reset/complete', { token: 'abc123', password: 'new-password-1' });
    expect(await screen.findByText(/signed out on every device/)).toBeInTheDocument();
  });

  it('explains a bad or missing link and offers a new one', async () => {
    (api.get as any).mockRejectedValue(new Error('This reset link is invalid, expired, or already used. Ask for a new one.'));
    renderAt('/reset-password?token=old');
    expect(await screen.findByText(/invalid, expired, or already used/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/forgot-password');

    renderAt('/reset-password');
    expect(await screen.findByText(/missing its code/)).toBeInTheDocument();
  });
});
