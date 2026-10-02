import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RentcastIntegration from './RentcastIntegration';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../../api';

const status = (over: Partial<any> = {}) => ({
  configured: false, book_key_set: false, key_hint: null, server_fallback: false, can_manage: true, ...over,
});
const renderPage = () => render(<MemoryRouter><RentcastIntegration /></MemoryRouter>);

describe('RentcastIntegration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('explains the setup steps, including choosing a plan, and shows Not connected', async () => {
    (api.get as any).mockResolvedValue(status());
    renderPage();
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText(/choose a plan/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/integrations/rentcast');
  });

  it('saves a key and then offers to delete it', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue(status());
    (api.put as any).mockResolvedValue(status({ configured: true, book_key_set: true, key_hint: '…1234' }));
    renderPage();
    await screen.findByText('Not connected');
    await user.type(screen.getByPlaceholderText('Paste your RentCast API key'), 'rc-key-1234');
    await user.click(screen.getByRole('button', { name: 'Save Key' }));
    expect(api.put).toHaveBeenCalledWith('/integrations/rentcast', { api_key: 'rc-key-1234' });
    expect(await screen.findByText(/using this book's key …1234/)).toBeInTheDocument();

    (api.put as any).mockResolvedValue(status());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.put).toHaveBeenLastCalledWith('/integrations/rentcast', { api_key: '' });
    expect(await screen.findByText('API key removed.')).toBeInTheDocument();
  });

  it('members see the status but no key field', async () => {
    (api.get as any).mockResolvedValue(status({ configured: true, server_fallback: true, can_manage: false }));
    renderPage();
    expect(await screen.findByText(/using the server key/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/RentCast API key/)).toBeNull();
    expect(screen.getByText(/Only an owner or admin/)).toBeInTheDocument();
  });

  it('shows a load or save error', async () => {
    (api.get as any).mockRejectedValue(new Error('load boom'));
    renderPage();
    expect(await screen.findByText('load boom')).toBeInTheDocument();
  });
});
