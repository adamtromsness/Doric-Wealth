import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AiIntegration from './AiIntegration';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api } from '../../api';

const settings = (over: Partial<any> = {}) => ({
  configured: true, user_key_set: false, key_hint: null, env_fallback: true, model: 'claude-sonnet-4-6', ...over,
});

describe('AiIntegration', () => {
  beforeEach(() => vi.clearAllMocks());
  const renderPage = () => render(<MemoryRouter><AiIntegration /></MemoryRouter>);

  it('loads settings and shows enabled-with-server-key status', async () => {
    (api.get as any).mockResolvedValue(settings());
    renderPage();
    await waitFor(() => expect(screen.getByText(/using the server key/)).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith('/auth/ai-settings');
  });

  it('shows the user-key hint when a personal key is set and offers Delete', async () => {
    (api.get as any).mockResolvedValue(settings({ user_key_set: true, key_hint: '…abcd' }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/using your key/)).toBeInTheDocument());
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('shows Not configured status', async () => {
    (api.get as any).mockResolvedValue(settings({ configured: false }));
    renderPage();
    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());
  });

  it('saves a new API key', async () => {
    (api.get as any).mockResolvedValue(settings());
    (api.put as any).mockResolvedValue(settings({ user_key_set: true, key_hint: '…wxyz' }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/using the server key/)).toBeInTheDocument());
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText('sk-ant-…');
    await user.type(input, 'sk-ant-newkey');
    await user.click(screen.getByText('Save Key'));
    expect(api.put).toHaveBeenCalledWith('/auth/ai-settings', { api_key: 'sk-ant-newkey' });
    await waitFor(() => expect(screen.getByText(/AI is enabled for your account/)).toBeInTheDocument());
  });

  it('shows the removed message when saving clears the key', async () => {
    (api.get as any).mockResolvedValue(settings());
    (api.put as any).mockResolvedValue(settings({ user_key_set: false }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/using the server key/)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('sk-ant-…'), 'x');
    await user.click(screen.getByText('Save Key'));
    await waitFor(() => expect(screen.getByText('API key removed.')).toBeInTheDocument());
  });

  it('surfaces an error when saving the key fails', async () => {
    (api.get as any).mockResolvedValue(settings());
    (api.put as any).mockRejectedValue(new Error('save boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/using the server key/)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('sk-ant-…'), 'x');
    await user.click(screen.getByText('Save Key'));
    await waitFor(() => expect(screen.getByText('save boom')).toBeInTheDocument());
  });

  it('removes the API key via Delete', async () => {
    (api.get as any).mockResolvedValue(settings({ user_key_set: true, key_hint: '…abcd' }));
    (api.put as any).mockResolvedValue(settings({ user_key_set: false }));
    renderPage();
    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Delete'));
    expect(api.put).toHaveBeenCalledWith('/auth/ai-settings', { api_key: '' });
    await waitFor(() => expect(screen.getByText('API key removed.')).toBeInTheDocument());
  });

  it('errors when Delete fails', async () => {
    (api.get as any).mockResolvedValue(settings({ user_key_set: true, key_hint: '…abcd' }));
    (api.put as any).mockRejectedValue(new Error('del boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByText('del boom')).toBeInTheDocument());
  });

  it('saves a changed model', async () => {
    (api.get as any).mockResolvedValue(settings());
    (api.put as any).mockResolvedValue(settings({ model: 'claude-opus-4-8' }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/using the server key/)).toBeInTheDocument());
    const user = userEvent.setup();
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'claude-opus-4-8');
    await user.click(screen.getByText('Save Model'));
    expect(api.put).toHaveBeenCalledWith('/auth/ai-settings', { model: 'claude-opus-4-8' });
    await waitFor(() => expect(screen.getByText('Model saved.')).toBeInTheDocument());
  });

  it('errors when saving the model fails', async () => {
    (api.get as any).mockResolvedValue(settings());
    (api.put as any).mockRejectedValue(new Error('model boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/using the server key/)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox'), 'claude-opus-4-8');
    await user.click(screen.getByText('Save Model'));
    await waitFor(() => expect(screen.getByText('model boom')).toBeInTheDocument());
  });

  it('renders a custom model option when the saved model is not in the list', async () => {
    (api.get as any).mockResolvedValue(settings({ model: 'claude-custom-99' }));
    renderPage();
    await waitFor(() => expect(screen.getByRole('option', { name: 'claude-custom-99' })).toBeInTheDocument());
  });

  it('ignores a load failure and stays at the loading status', async () => {
    (api.get as any).mockRejectedValue(new Error('nope'));
    renderPage();
    // Status stays at the "…" placeholder (never resolves to enabled/not-configured).
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.getByText(/Status:/)).toBeInTheDocument();
    expect(screen.queryByText(/Enabled/)).toBeNull();
    expect(screen.queryByText('Not configured')).toBeNull();
  });
});
