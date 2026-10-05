import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Privacy from './Privacy';

let authUser: any = null;
vi.mock('../auth', () => ({ useAuth: () => ({ user: authUser }), displayName: () => '' }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

const renderPage = () => render(<MemoryRouter><Privacy /></MemoryRouter>);

describe('Privacy page', () => {
  beforeEach(() => { vi.clearAllMocks(); authUser = null; });

  it('explains what leaves Doric and who to contact (operator email when configured)', async () => {
    (api.get as any).mockResolvedValue({ contact_email: 'help@doric.example' });
    renderPage();
    expect(screen.getByRole('heading', { name: 'When data leaves Doric' })).toBeInTheDocument();
    for (const svc of ['Anthropic', 'SimpleFIN', 'RentCast', 'NHTSA', 'Google Fonts']) expect(screen.getByText(svc)).toBeInTheDocument();
    expect(screen.getByText(/no ads, no analytics and no tracking/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'help@doric.example' })).toHaveAttribute('href', 'mailto:help@doric.example');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument();
  });

  it('without a contact email, points to the person who invited you; signed in, it renders as a page', async () => {
    authUser = { id: 1, email: 'a@b.c' };
    (api.get as any).mockResolvedValue({ contact_email: null });
    renderPage();
    expect(screen.getByRole('heading', { name: 'Privacy', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/contact the person who invited you to Doric/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to sign in' })).toBeNull();
  });
});
