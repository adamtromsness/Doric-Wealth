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
    (api.get as any).mockResolvedValue({ contact_email: 'help@doric.example', https: true, backup_keep_days: 30, offsite_backups: true });
    renderPage();
    expect(api.get).toHaveBeenCalledWith('/auth/privacy');
    expect(screen.getByRole('heading', { name: 'When data leaves Doric' })).toBeInTheDocument();
    for (const svc of ['Anthropic', 'SimpleFIN', 'RentCast', 'NHTSA', 'Google Fonts']) expect(screen.getByText(svc)).toBeInTheDocument();
    expect(screen.getByText(/no ads, no analytics and no tracking/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'help@doric.example' })).toHaveAttribute('href', 'mailto:help@doric.example');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument();
    // Background work is described, not denied.
    expect(screen.getByText(/works in the background only for features you turn on/)).toBeInTheDocument();
    // Configuration-dependent statements match the server's settings.
    expect(screen.getByText(/Connections use HTTPS/)).toBeInTheDocument();
    expect(screen.getByText(/kept for 30 days, with a copy stored off the server/)).toBeInTheDocument();
    expect(screen.getByText(/up to 30 days later/)).toBeInTheDocument();
  });

  it("doesn't claim HTTPS or a backup schedule the server isn't set up for", async () => {
    (api.get as any).mockResolvedValue({ contact_email: null, https: false, backup_keep_days: null, offsite_backups: false });
    renderPage();
    expect(await screen.findByText(/Backups of the server are up to the person running Doric/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTPS/)).toBeNull();
    expect(screen.queryByText(/kept for \d+ days/)).toBeNull();
    expect(screen.getByText(/stays in the server's backups until they expire, and is then gone/)).toBeInTheDocument();
  });

  it('without a contact email, points to the person who invited you; signed in, it renders as a page', async () => {
    authUser = { id: 1, email: 'a@b.c' };
    (api.get as any).mockResolvedValue({ contact_email: null, https: true, backup_keep_days: 30, offsite_backups: false });
    renderPage();
    expect(screen.getByRole('heading', { name: 'Privacy', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/contact the person who invited you to Doric/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to sign in' })).toBeNull();
  });
});
