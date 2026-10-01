import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Register from './Register';

const register = vi.fn();
vi.mock('../auth', () => ({
  useAuth: () => ({ register }),
  displayName: (u: any) => u?.name ?? '',
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

// GET fixtures: the signup config, and book-invite previews by code.
function setup(opts: { invite_only?: boolean; first_account?: boolean; bookInvites?: Record<string, string> } = {}) {
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/auth/signup-config') {
      return Promise.resolve({ invite_only: opts.invite_only ?? false, first_account: opts.first_account ?? false });
    }
    const m = /^\/invites\/(.+)$/.exec(path);
    if (m) {
      const book = opts.bookInvites?.[decodeURIComponent(m[1])];
      return book ? Promise.resolve({ book_name: book, role: 'member' }) : Promise.reject(new Error('This invite link is invalid or has expired.'));
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

const renderAt = (path = '/register') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<div>home page</div>} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );

const fill = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement, email: string, password: string) => {
  await user.type(container.querySelector('input[type="email"]')!, email);
  await user.type(container.querySelector('input[type="password"]')!, password);
};
const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Create Account' }));

describe('Register page', () => {
  beforeEach(() => { register.mockReset(); setup(); });

  it('renders the open sign-up form with the books-name field', async () => {
    renderAt();
    expect(screen.getByText('Create your account')).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/signup-config'));
    expect(screen.getByText('Start tracking your finances.')).toBeInTheDocument();
    expect(screen.getByText('Books Name')).toBeInTheDocument();
    expect(screen.queryByText('Invite Code')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('rejects passwords shorter than 8 characters without calling register', async () => {
    const user = userEvent.setup();
    const { container } = renderAt();
    await fill(user, container, 'a@b.com', 'short');
    await submit(user);
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('submits the full payload and navigates home', async () => {
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt();
    const inputs = container.querySelectorAll('input');
    await user.type(inputs[0], 'Ada'); // name
    await fill(user, container, 'a@b.com', 'password1');
    await user.type(inputs[3], 'The Smiths'); // book_name
    await submit(user);
    expect(register).toHaveBeenCalledWith({
      email: 'a@b.com', password: 'password1', name: 'Ada', book_name: 'The Smiths', invite_code: undefined,
    });
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });

  it('shows an error when register rejects', async () => {
    register.mockRejectedValue(new Error('email taken'));
    const user = userEvent.setup();
    const { container } = renderAt();
    await fill(user, container, 'a@b.com', 'password1');
    await submit(user);
    await waitFor(() => expect(screen.getByText('email taken')).toBeInTheDocument());
  });

  it('invite-only without a code in the link: asks for one and sends it', async () => {
    setup({ invite_only: true });
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt();
    expect(await screen.findByText('Invite Code')).toBeInTheDocument();
    expect(screen.getByText('Sign-up is by invitation. Enter the code from your invite.')).toBeInTheDocument();

    await fill(user, container, 'a@b.com', 'password1');
    await submit(user);
    expect(screen.getByText('Enter the invite code from your invitation.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('from your invite link'), '  abc123  ');
    await submit(user);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.com', invite_code: 'abc123' }));
  });

  it('invite-only on an empty database (first account): no code needed', async () => {
    setup({ invite_only: true, first_account: true });
    renderAt();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/signup-config'));
    expect(screen.queryByText('Invite Code')).toBeNull();
    expect(screen.getByText('Start tracking your finances.')).toBeInTheDocument();
  });

  it('a signup-invite link: keeps Books Name, sends the code, no code field', async () => {
    setup({ invite_only: true });
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt('/register?code=signup123');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/invites/signup123'));
    expect(screen.queryByText('Invite Code')).toBeNull();
    expect(screen.getByText('Books Name')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?code=signup123');
    await fill(user, container, 'a@b.com', 'password1');
    await submit(user);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ invite_code: 'signup123' }));
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });

  it('a book-invite link: names the book, hides Books Name, and joins on sign-up', async () => {
    setup({ invite_only: true, bookInvites: { fam42: 'Family Book' } });
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt('/register?code=fam42');
    expect(await screen.findByText("You're joining Family Book. Create an account to get started.")).toBeInTheDocument();
    expect(screen.queryByText('Books Name')).toBeNull();
    await fill(user, container, 'a@b.com', 'password1');
    await submit(user);
    expect(register).toHaveBeenCalledWith({
      email: 'a@b.com', password: 'password1', name: undefined, book_name: undefined, invite_code: 'fam42',
    });
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });
});
