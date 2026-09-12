import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Account from './Account';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

const refresh = vi.fn();
vi.mock('../auth', () => ({
  useAuth: () => ({ refresh }),
  displayName: (u: any) => u?.name ?? '',
}));

const profileFixture = {
  email: 'ada@b.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  employment_status: 'employed',
  dependants: [
    { id: 5, first_name: 'Kid', middle_name: null, last_name: 'Smith', name: 'Kid Smith', relationship: 'Child', dob: '2015-06-01', notes: null },
  ],
};

const renderPage = () => render(<MemoryRouter><Account /></MemoryRouter>);

describe('Account page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockResolvedValue(profileFixture);
    (api.put as any).mockResolvedValue({});
    (api.post as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue(undefined);
  });

  it('loads the profile into the form', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Ada')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Lovelace')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ada@b.com')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/auth/profile');
  });

  it('shows a load error', async () => {
    (api.get as any).mockRejectedValue(new Error('nope'));
    renderPage();
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  it('enables Save when the form is dirty and PUTs a trimmed, nulled payload', async () => {
    const user = userEvent.setup();
    renderPage();
    const first = await screen.findByDisplayValue('Ada');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    await user.type(first, 'x');
    const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/profile', expect.objectContaining({
      first_name: 'Adax', last_name: 'Lovelace', middle_name: null,
    })));
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled());
  });

  it('surfaces a save error', async () => {
    (api.put as any).mockRejectedValue(new Error('save failed'));
    const user = userEvent.setup();
    renderPage();
    const first = await screen.findByDisplayValue('Ada');
    await user.type(first, 'x');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('save failed')).toBeInTheDocument();
  });

  it('switches tabs and edits occupation/retirement/emergency fields', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Ada');
    await user.click(screen.getByRole('button', { name: 'Occupation' }));
    expect(screen.getByText('Annual Income')).toBeInTheDocument();
    // select carried its seeded value
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('employed');
    await user.selectOptions(screen.getByRole('combobox'), 'retired');
    await user.click(screen.getByRole('button', { name: 'Retirement' }));
    expect(screen.getByText('Retirement Planning')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Emergency' }));
    expect(screen.getByText('Emergency Contact')).toBeInTheDocument();
  });

  describe('dependants tab', () => {
    it('lists existing dependants and adds a new one', async () => {
      const newRow = { id: 9, first_name: 'Sam', middle_name: null, last_name: 'Smith', name: 'Sam Smith', relationship: null, dob: null, notes: null };
      (api.post as any).mockResolvedValue(newRow);
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      expect(screen.getByText('Kid Smith')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Add Dependant' }));
      // The inline editor's first input is First Name.
      const firstNameInputs = screen.getAllByRole('textbox');
      await user.type(firstNameInputs[0], 'Sam');
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/dependants', expect.objectContaining({ first_name: 'Sam' })));
      expect(await screen.findByText('Sam Smith')).toBeInTheDocument();
    });

    it('blocks a nameless dependant', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      await user.click(screen.getByRole('button', { name: 'Add Dependant' }));
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(await screen.findByText('A dependant needs a first or last name.')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('cancels the editor', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      await user.click(screen.getByRole('button', { name: 'Add Dependant' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'Add Dependant' })).toBeInTheDocument();
    });

    it('edits an existing dependant', async () => {
      const updated = { id: 5, first_name: 'Kiddo', middle_name: null, last_name: 'Smith', name: 'Kiddo Smith', relationship: 'Child', dob: '2015-06-01', notes: null };
      (api.put as any).mockResolvedValue(updated);
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      const firstName = screen.getByDisplayValue('Kid');
      await user.clear(firstName);
      await user.type(firstName, 'Kiddo');
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/dependants/5', expect.objectContaining({ first_name: 'Kiddo' })));
      expect(await screen.findByText('Kiddo Smith')).toBeInTheDocument();
    });

    it('deletes a dependant', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(api.del).toHaveBeenCalledWith('/auth/dependants/5'));
      await waitFor(() => expect(screen.queryByText('Kid Smith')).toBeNull());
    });

    it('shows an empty state when there are no dependants', async () => {
      (api.get as any).mockResolvedValue({ ...profileFixture, dependants: [] });
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      expect(screen.getByText('No dependants added yet.')).toBeInTheDocument();
    });
  });
});
