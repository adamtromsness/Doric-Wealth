import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EntityBeneficiaries } from './EntityBeneficiaries';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const BASE = '/accounts/5';

const rows = [
  { id: 1, name: 'Jane Doe', relationship: 'Spouse', kind: 'primary', percentage: 60, notes: 'note one' },
  { id: 2, name: 'John Doe', relationship: null, kind: 'primary', percentage: 30, notes: null },
  { id: 3, name: 'Baby Doe', relationship: 'Child', kind: 'contingent', percentage: 100, notes: null },
];

const setList = (list: any[]) =>
  (api.get as any).mockImplementation((path: string) =>
    path === `${BASE}/beneficiaries` ? Promise.resolve(list) : Promise.resolve([]));

const renderPage = () => render(<MemoryRouter><EntityBeneficiaries basePath={BASE} /></MemoryRouter>);

describe('EntityBeneficiaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows an empty state when there are no beneficiaries', async () => {
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No beneficiaries yet/)).toBeInTheDocument());
  });

  it('renders primary and contingent groups plus the percentage hint', async () => {
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('Contingent')).toBeInTheDocument();
    expect(screen.getByText('Baby Doe')).toBeInTheDocument();
    // primary sum is 90 (!=100) -> hint shows current pct
    expect(screen.getByText(/currently 90%/)).toBeInTheDocument();
    expect(screen.getByText(/note one/)).toBeInTheDocument();
  });

  it('validates the name and creates a beneficiary', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No beneficiaries yet/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Beneficiary' }));
    // click Add (the form's) without a name -> validation
    const formAdd = screen.getAllByRole('button', { name: 'Add Beneficiary' }).slice(-1)[0];
    await user.click(formAdd);
    expect(screen.getByText('Name is required.')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Full name'), 'New Person');
    await user.type(screen.getByPlaceholderText('e.g. Spouse, Child'), 'Friend');
    await user.click(screen.getAllByRole('button', { name: 'Add Beneficiary' }).slice(-1)[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/beneficiaries`, expect.objectContaining({ name: 'New Person', relationship: 'Friend', kind: 'primary' })));
    // reloads after save
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('edits an existing beneficiary and changes the kind', async () => {
    const user = userEvent.setup();
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    // First edit button belongs to Jane Doe (id 1)
    const editButtons = screen.getAllByTitle('Edit');
    await user.click(editButtons[0]);
    const nameInput = screen.getByPlaceholderText('Full name') as HTMLInputElement;
    expect(nameInput.value).toBe('Jane Doe');

    await user.selectOptions(screen.getByRole('combobox'), 'contingent');
    await user.clear(nameInput);
    await user.type(nameInput, 'Jane Updated');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${BASE}/beneficiaries/1`, expect.objectContaining({ name: 'Jane Updated', kind: 'contingent' })));
  });

  it('deletes a beneficiary when confirmed and skips when cancelled', async () => {
    const user = userEvent.setup();
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    // cancel path
    (window.confirm as any).mockReturnValueOnce(false);
    await user.click(screen.getAllByTitle('Remove')[0]);
    expect(api.del).not.toHaveBeenCalled();

    // confirmed path
    await user.click(screen.getAllByTitle('Remove')[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(`${BASE}/beneficiaries/1`));
  });

  it('surfaces an error when saving fails', async () => {
    const user = userEvent.setup();
    setList([]);
    (api.post as any).mockRejectedValueOnce(new Error('save boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No beneficiaries yet/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add Beneficiary' }));
    await user.type(screen.getByPlaceholderText('Full name'), 'X');
    await user.click(screen.getAllByRole('button', { name: 'Add Beneficiary' }).slice(-1)[0]);
    await waitFor(() => expect(screen.getByText('save boom')).toBeInTheDocument());
  });

  it('cancels the editor', async () => {
    const user = userEvent.setup();
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No beneficiaries yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add Beneficiary' }));
    expect(screen.getByPlaceholderText('Full name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Full name')).toBeNull();
  });

  it('closes the editor when the row being edited is deleted', async () => {
    const user = userEvent.setup();
    setList(rows);
    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await user.click(screen.getAllByTitle('Edit')[0]);
    expect(screen.getByPlaceholderText('Full name')).toBeInTheDocument();
    await user.click(screen.getAllByTitle('Remove')[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalled());
  });
});
