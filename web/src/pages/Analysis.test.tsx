import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Analysis from './Analysis';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api } from '../api';

const savedRow = {
  id: 1, kind: 'spending_overview', subject_id: null, title: 'My saved report',
  result: '# Overview\n\nYou spend a lot.', model: 'claude-sonnet-4-6', created_at: '2026-08-01',
};

const mockGet = (status: any, saved: any[] = []) =>
  (api.get as any).mockImplementation((path: string) => {
    if (path === '/analysis/status') return Promise.resolve(status);
    if (path === '/analysis') return Promise.resolve(saved);
    return Promise.resolve({});
  });

describe('Analysis page', () => {
  beforeEach(() => vi.clearAllMocks());
  const renderPage = () => render(<MemoryRouter><Analysis /></MemoryRouter>);

  it('shows a not-configured banner and empty saved list', async () => {
    mockGet({ configured: false, model: 'x' }, []);
    renderPage();
    await waitFor(() => expect(screen.getByText(/AI is not configured/)).toBeInTheDocument());
    expect(screen.getByText(/No saved analyses yet/)).toBeInTheDocument();
  });

  it('shows the model line and saved analyses when configured', async () => {
    mockGet({ configured: true, model: 'claude-sonnet-4-6' }, [savedRow]);
    renderPage();
    // Model appears in the header line and the saved-row cell.
    await waitFor(() => expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0));
    expect(screen.getByText('Spending overview')).toBeInTheDocument();
  });

  it('runs the spending overview and renders the AI result', async () => {
    mockGet({ configured: true, model: 'm' }, []);
    (api.post as any).mockResolvedValue({ result: '# Result\n\nAll good.' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Run Overview')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Run Overview'));
    expect(api.post).toHaveBeenCalledWith('/analysis/overview');
    await waitFor(() => expect(screen.getByText('Result')).toBeInTheDocument());
  });

  it('runs the product analysis', async () => {
    mockGet({ configured: true, model: 'm' }, []);
    (api.post as any).mockResolvedValue({ result: 'products text' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Analyze Products')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Analyze Products'));
    expect(api.post).toHaveBeenCalledWith('/analysis/products');
    await waitFor(() => expect(screen.getByText('products text')).toBeInTheDocument());
  });

  it('validates an empty custom question', async () => {
    mockGet({ configured: true, model: 'm' }, []);
    renderPage();
    await waitFor(() => expect(screen.getByText('Ask')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Ask'));
    expect(screen.getByText('Type a question first.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('submits a custom question via Enter and shows its titled result', async () => {
    mockGet({ configured: true, model: 'm' }, []);
    (api.post as any).mockResolvedValue({ result: 'answer body' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Ask')).toBeInTheDocument());
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(/Which category grew/);
    await user.type(input, 'How much?{Enter}');
    expect(api.post).toHaveBeenCalledWith('/analysis/custom', { question: 'How much?' });
    await waitFor(() => expect(screen.getByText('Q: How much?')).toBeInTheDocument());
    expect(screen.getByText('answer body')).toBeInTheDocument();
  });

  it('surfaces an error when a run fails', async () => {
    mockGet({ configured: true, model: 'm' }, []);
    (api.post as any).mockRejectedValue(new Error('run failed'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run Overview')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('Run Overview'));
    await waitFor(() => expect(screen.getByText('run failed')).toBeInTheDocument());
  });

  it('opens a saved analysis in a modal and closes it', async () => {
    mockGet({ configured: true, model: 'm' }, [{ ...savedRow, kind: 'unknown_kind' }]);
    renderPage();
    // The row's kind is not in KIND_LABEL, so the Type cell shows the raw kind.
    await waitFor(() => expect(screen.getByText('unknown_kind')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByText('My saved report'));
    // Modal shows the raw kind fallback and Close button.
    await waitFor(() => expect(screen.getByText('Close')).toBeInTheDocument());
    await user.click(screen.getByText('Close'));
    await waitFor(() => expect(screen.queryByText('Close')).toBeNull());
  });
});
