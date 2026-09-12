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

const renderAt = (path = '/register') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<div>home page</div>} />
        <Route path="/accept" element={<div>accept page</div>} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );

const fill = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement, email: string, password: string) => {
  await user.type(container.querySelector('input[type="email"]')!, email);
  await user.type(container.querySelector('input[type="password"]')!, password);
};

describe('Register page', () => {
  beforeEach(() => { register.mockReset(); });

  it('renders the create-account form with the books-name field when no code', () => {
    renderAt();
    expect(screen.getByText('Create your account')).toBeInTheDocument();
    expect(screen.getByText('Start tracking your finances.')).toBeInTheDocument();
    expect(screen.getByText('Books Name')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('rejects passwords shorter than 8 characters without calling register', async () => {
    const user = userEvent.setup();
    const { container } = renderAt();
    await fill(user, container, 'a@b.com', 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('submits full payload and navigates home on success', async () => {
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt();
    const inputs = container.querySelectorAll('input');
    await user.type(inputs[0], 'Ada'); // name
    await fill(user, container, 'a@b.com', 'password1');
    await user.type(inputs[3], 'The Smiths'); // book_name
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(register).toHaveBeenCalledWith({
      email: 'a@b.com', password: 'password1', name: 'Ada', book_name: 'The Smiths',
    });
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });

  it('omits blank optional fields from the payload', async () => {
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt();
    await fill(user, container, 'a@b.com', 'password1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(register).toHaveBeenCalledWith({
      email: 'a@b.com', password: 'password1', name: undefined, book_name: undefined,
    });
  });

  it('shows an error when register rejects', async () => {
    register.mockRejectedValue(new Error('email taken'));
    const user = userEvent.setup();
    const { container } = renderAt();
    await fill(user, container, 'a@b.com', 'password1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByText('email taken')).toBeInTheDocument());
  });

  it('hides books-name and carries the code when invited', async () => {
    register.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderAt('/register?code=xyz');
    expect(screen.queryByText('Books Name')).toBeNull();
    expect(screen.getByText(/Create an account, then open the books/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?code=xyz');
    await fill(user, container, 'a@b.com', 'password1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByText('accept page')).toBeInTheDocument());
  });
});
