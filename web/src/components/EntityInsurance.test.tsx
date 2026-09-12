import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EntityInsurance } from './EntityInsurance';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const BASE = '/vehicles/1';

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const policies = [
  { id: 1, policy_type: 'Auto', carrier: 'State Farm', policy_number: 'A1', premium: 100, premium_cycle: 'monthly',
    coverage: '100/300', deductible: 500, agent_name: 'Sam Agent', agent_phone: '8005550100',
    start_date: '2026-01-01', renewal_date: iso(-10), notes: 'past' },
  { id: 2, policy_type: 'Comprehensive', carrier: 'Geico', policy_number: 'B2', premium: 50, premium_cycle: 'annual',
    coverage: null, deductible: null, agent_name: null, agent_phone: null,
    start_date: null, renewal_date: iso(15), notes: null },
  { id: 3, policy_type: null, carrier: null, policy_number: null, premium: null, premium_cycle: 'monthly',
    coverage: null, deductible: null, agent_name: null, agent_phone: null,
    start_date: null, renewal_date: iso(400), notes: null },
];

const setList = (list: any[]) =>
  (api.get as any).mockImplementation((path: string) =>
    path === `${BASE}/insurance` ? Promise.resolve(list) : Promise.resolve([]));

const renderPage = () => render(<MemoryRouter><EntityInsurance basePath={BASE} typeHint="e.g. Auto" /></MemoryRouter>);

describe('EntityInsurance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the empty state', async () => {
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No insurance policies yet/)).toBeInTheDocument());
  });

  it('renders policies with renewal tags, agent link and premium cycle', async () => {
    setList(policies);
    renderPage();
    await waitFor(() => expect(screen.getByText('Auto')).toBeInTheDocument());
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(screen.getByText(/in 15d/)).toBeInTheDocument();
    // agent phone link + name
    expect(screen.getByText(/Sam Agent/)).toBeInTheDocument();
    const telLink = document.querySelector('a[href^="tel:"]');
    expect(telLink).toBeTruthy();
    // premium cycle label (rendered as "/ Monthly" in the premium cell)
    expect(screen.getByText(/Monthly/)).toBeInTheDocument();
  });

  it('adds a policy, changing cycle and formatting the phone on blur', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No insurance policies yet/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Policy' }));
    await user.type(screen.getByPlaceholderText('e.g. Auto'), 'Liability');
    await user.type(screen.getByPlaceholderText('e.g. State Farm'), 'Allstate');
    const cycle = screen.getByRole('combobox');
    await user.selectOptions(cycle, 'quarterly');

    const phone = screen.getByPlaceholderText('e.g. (800) 555-0100');
    await user.type(phone, '8005551234');
    await user.tab(); // blur -> formatPhone

    await user.click(screen.getAllByRole('button', { name: 'Add Policy' }).slice(-1)[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/insurance`, expect.objectContaining({ policy_type: 'Liability', carrier: 'Allstate', premium_cycle: 'quarterly' })));
  });

  it('edits an existing policy', async () => {
    const user = userEvent.setup();
    setList(policies);
    renderPage();
    await waitFor(() => expect(screen.getByText('Auto')).toBeInTheDocument());

    await user.click(screen.getAllByTitle('Edit')[0]);
    const carrier = screen.getByPlaceholderText('e.g. State Farm') as HTMLInputElement;
    expect(carrier.value).toBe('State Farm');
    await user.clear(carrier);
    await user.type(carrier, 'Progressive');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${BASE}/insurance/1`, expect.objectContaining({ carrier: 'Progressive' })));
  });

  it('deletes when confirmed and skips when cancelled', async () => {
    const user = userEvent.setup();
    setList(policies);
    renderPage();
    await waitFor(() => expect(screen.getByText('Auto')).toBeInTheDocument());

    (window.confirm as any).mockReturnValueOnce(false);
    await user.click(screen.getAllByTitle('Delete')[0]);
    expect(api.del).not.toHaveBeenCalled();

    await user.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(`${BASE}/insurance/1`));
  });

  it('surfaces an error when saving fails', async () => {
    const user = userEvent.setup();
    setList([]);
    (api.post as any).mockRejectedValueOnce(new Error('policy boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No insurance policies yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Policy' }));
    await user.click(screen.getAllByRole('button', { name: 'Add Policy' }).slice(-1)[0]);
    await waitFor(() => expect(screen.getByText('policy boom')).toBeInTheDocument());
  });

  it('cancels the editor', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No insurance policies yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Policy' }));
    expect(screen.getByPlaceholderText('e.g. State Farm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('e.g. State Farm')).toBeNull();
  });
});
