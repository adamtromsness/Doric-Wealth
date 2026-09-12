import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

// The shell reads auth state directly; drive it from a mutable value so each test
// can pick a ready/logged-in combination.
const authValue: any = { ready: true, user: null, books: [], activeBook: null };
vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return { ...actual, useAuth: () => authValue };
});

// Every request the shell makes (subscription suggestions, user menu) resolves empty.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    api: { get: vi.fn(() => Promise.resolve([])), post: vi.fn(() => Promise.resolve({})), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

// Route targets are stubbed: App's job is the shell and the route table, not the
// pages themselves (each of which has its own test).
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Dashboard Stub</div> }));
vi.mock('./pages/Login', () => ({ default: () => <div>Login Stub</div> }));
vi.mock('./pages/Register', () => ({ default: () => <div>Register Stub</div> }));
vi.mock('./pages/Transactions', () => ({ default: () => <div>Transactions Stub</div> }));

const renderAt = (path: string) =>
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

const user = { id: 1, email: 'ada@example.com', preferred_name: 'Ada' };

describe('App shell', () => {
  beforeEach(() => {
    authValue.ready = true;
    authValue.user = null;
    authValue.books = [];
    authValue.activeBook = null;
  });

  it('shows a full-page loader until auth resolves', () => {
    authValue.ready = false;
    renderAt('/');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    // The shell itself is not mounted yet.
    expect(screen.queryByText(/self-hosted/)).toBeNull();
  });

  it('serves the auth screens when logged out', async () => {
    renderAt('/login');
    expect(await screen.findByText('Login Stub')).toBeInTheDocument();
    expect(screen.queryByText(/self-hosted/)).toBeNull();
  });

  it('serves the register screen when logged out', async () => {
    renderAt('/register');
    expect(await screen.findByText('Register Stub')).toBeInTheDocument();
  });

  it('redirects an unknown logged-out path to the login screen', async () => {
    renderAt('/transactions');
    expect(await screen.findByText('Login Stub')).toBeInTheDocument();
    expect(screen.queryByText('Transactions Stub')).toBeNull();
  });

  it('renders the sidebar, greeting and matched route once logged in', async () => {
    authValue.user = user;
    authValue.activeBook = { id: 3, name: 'Household', role: 'owner' };
    renderAt('/');

    expect(await screen.findByText('Dashboard Stub')).toBeInTheDocument();
    // Wordmark and every nav section.
    expect(screen.getByText(/self-hosted/)).toBeInTheDocument();
    for (const section of ['Overview', 'Track', 'Assets', 'Liabilities', 'Insight']) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    // A representative link from each section.
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Categories & Tags' })).toHaveAttribute('href', '/categories');
    expect(screen.getByRole('link', { name: 'Other Liabilities' })).toHaveAttribute('href', '/other-liabilities');
    expect(screen.getByRole('link', { name: 'Grocery Insights' })).toHaveAttribute('href', '/grocery-insights');
    // Greeting names the user and the active book.
    expect(screen.getByText(/Hi Ada\./)).toBeInTheDocument();
    expect(screen.getByText('Household')).toBeInTheDocument();
    // Version badge comes from the build-time define.
    expect(screen.getByTitle('Software version')).toHaveTextContent(/^v\d+/);
  });

  it('omits the book clause when no book is active', async () => {
    authValue.user = user;
    renderAt('/');
    expect(await screen.findByText('Dashboard Stub')).toBeInTheDocument();
    expect(screen.getByText(/Hi Ada\./)).toBeInTheDocument();
    expect(screen.queryByText(/You are working on/)).toBeNull();
  });

  it('routes a logged-in user to a nested page', async () => {
    authValue.user = user;
    renderAt('/transactions');
    expect(await screen.findByText('Transactions Stub')).toBeInTheDocument();
  });

  it('redirects an unknown logged-in path back to the dashboard', async () => {
    authValue.user = user;
    renderAt('/no-such-page');
    expect(await screen.findByText('Dashboard Stub')).toBeInTheDocument();
  });
});
