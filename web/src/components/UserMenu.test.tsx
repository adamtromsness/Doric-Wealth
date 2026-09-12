import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { UserMenu } from './UserMenu';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

const switchBook = vi.fn();
const logout = vi.fn();
let authState: any;
vi.mock('../auth', () => ({
  useAuth: () => authState,
  displayName: (u: any) => u?.name ?? '',
}));

const baseAuth = () => ({
  user: { id: 1, email: 'ada@b.com', name: 'Ada Lovelace' },
  books: [{ id: 1, name: 'Home', role: 'owner' }],
  activeBook: { id: 1, name: 'Home', role: 'owner' },
  switchBook, logout,
});

const renderMenu = () => render(<MemoryRouter><UserMenu /></MemoryRouter>);

describe('UserMenu', () => {
  beforeEach(() => {
    navigate.mockReset(); switchBook.mockReset(); logout.mockReset();
    authState = baseAuth();
  });

  it('renders nothing when there is no user', () => {
    authState = { ...baseAuth(), user: null };
    const { container } = renderMenu();
    expect(container.firstChild).toBeNull();
  });

  it('shows the name and two-letter monogram, closed by default', () => {
    renderMenu();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument(); // initials from two words
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('falls back to the email and its first two letters when there is no name', () => {
    authState = { ...baseAuth(), user: { id: 2, email: 'zack@b.com', name: null } };
    renderMenu();
    expect(screen.getByText('zack@b.com')).toBeInTheDocument();
    expect(screen.getAllByText('ZA').length).toBeGreaterThan(0);
  });

  it('opens the menu and navigates to the profile pages', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTitle('Account & settings'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'My Profile' }));
    expect(navigate).toHaveBeenCalledWith('/account');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('navigates to the other menu destinations', async () => {
    const user = userEvent.setup();
    renderMenu();
    const open = () => user.click(screen.getByTitle('Account & settings'));
    await open();
    await user.click(screen.getByRole('menuitem', { name: 'My Books' }));
    expect(navigate).toHaveBeenCalledWith('/book');
    await open();
    await user.click(screen.getByRole('menuitem', { name: 'My Data' }));
    expect(navigate).toHaveBeenCalledWith('/my-data');
    await open();
    await user.click(screen.getByRole('menuitem', { name: 'SimpleFIN' }));
    expect(navigate).toHaveBeenCalledWith('/integrations/simplefin');
    await open();
    await user.click(screen.getByRole('menuitem', { name: 'AI' }));
    expect(navigate).toHaveBeenCalledWith('/integrations/ai');
  });

  it('signs out via the danger item', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTitle('Account & settings'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalled();
  });

  it('closes on Escape and outside click', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTitle('Account & settings'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Re-open, then click outside.
    await user.click(screen.getByTitle('Account & settings'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  describe('with multiple books', () => {
    const assignSpy = vi.fn();
    beforeEach(() => {
      authState = {
        ...baseAuth(),
        books: [
          { id: 1, name: 'Home', role: 'owner' },
          { id: 2, name: 'Rental', role: 'admin' },
        ],
      };
      assignSpy.mockReset();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, assign: assignSpy },
        writable: true,
      });
    });

    it('shows a switcher, ignores the active book, and switches to another', async () => {
      switchBook.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderMenu();
      await user.click(screen.getByTitle('Account & settings'));
      expect(screen.getByText('Switch books')).toBeInTheDocument();

      // Clicking the already-active book switches nothing.
      await user.click(screen.getByRole('menuitem', { name: /Home/ }));
      expect(switchBook).not.toHaveBeenCalled();

      // Re-open and pick the other book.
      await user.click(screen.getByTitle('Account & settings'));
      await user.click(screen.getByRole('menuitem', { name: /Rental/ }));
      expect(switchBook).toHaveBeenCalledWith(2);
      await waitFor(() => expect(assignSpy).toHaveBeenCalledWith('/'));
    });
  });
});

afterEach(() => vi.clearAllMocks());
