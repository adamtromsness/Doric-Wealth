import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Account from './Account';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api, ageOn, earliestDob, todayStr } from '../api';

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
  annual_income: 127000,
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

  it('shows profile money fields as money ($127,000.00) and saves the plain number', async () => {
    const user = userEvent.setup();
    (api.put as any).mockResolvedValue({ ...profileFixture, annual_income: 130000 });
    renderPage();
    await screen.findByDisplayValue('Ada');
    await user.click(screen.getByRole('button', { name: 'Occupation' }));
    const income = screen.getByDisplayValue('$127,000.00');
    await user.click(income);
    expect(income).toHaveValue('127000');
    await user.clear(income);
    await user.type(income, '130000');
    await user.tab();
    expect(income).toHaveValue('$130,000.00');
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

    it('shows each dependant\'s age next to their date of birth', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      expect(screen.getByRole('columnheader', { name: 'Age' })).toBeInTheDocument();
      const row = screen.getByText('Kid Smith').closest('tr') as HTMLElement;
      expect(within(row).getByText(String(ageOn('2015-06-01')))).toBeInTheDocument();
    });

    it('limits the date of birth to the last 120 years and blocks saving an older one', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByDisplayValue('Ada');
      await user.click(screen.getByRole('button', { name: 'Dependants' }));
      await user.click(screen.getByRole('button', { name: 'Add Dependant' }));
      await user.type(screen.getAllByRole('textbox')[0], 'Old');
      const dob = document.querySelector('.card input[type="date"][min]') as HTMLInputElement;
      expect(dob.min).toBe(earliestDob());
      expect(dob.max).toBe(todayStr());
      fireEvent.change(dob, { target: { value: '1850-01-01' } });
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(await screen.findByText("Date of birth can't be more than 120 years ago.")).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();
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

describe('Account security tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockResolvedValue(profileFixture);
    (api.put as any).mockResolvedValue({ ended: 0 });
    (api.post as any).mockResolvedValue({ ended: 0 });
  });

  const openSecurity = async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Security' });
    await userEvent.click(screen.getByRole('button', { name: 'Security' }));
  };

  it('hides the shared Save Changes button on this tab', async () => {
    await openSecurity();
    expect(screen.getByText('Change Password', { selector: '.label' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
  });

  it('changes the password and reports the sessions it ended', async () => {
    (api.put as any).mockResolvedValue({ ended: 2 });
    await openSecurity();
    await userEvent.type(screen.getByLabelText('Current Password'), 'supersecret');
    await userEvent.type(screen.getByLabelText('New Password'), 'brand-new-secret');
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'brand-new-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/password', {
      current_password: 'supersecret', new_password: 'brand-new-secret',
    }));
    expect(await screen.findByText(/Password changed\. Signed out 2 other sessions\./)).toBeInTheDocument();
    // The fields are cleared so the new password isn't left sitting in the DOM.
    expect(screen.getByLabelText('Current Password')).toHaveValue('');
    expect(screen.getByLabelText('New Password')).toHaveValue('');
  });

  it('uses the singular when only one session ended', async () => {
    (api.put as any).mockResolvedValue({ ended: 1 });
    await openSecurity();
    await userEvent.type(screen.getByLabelText('Current Password'), 'supersecret');
    await userEvent.type(screen.getByLabelText('New Password'), 'brand-new-secret');
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'brand-new-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText(/Signed out 1 other session\./)).toBeInTheDocument();
  });

  it('says so when there were no other sessions', async () => {
    await openSecurity();
    await userEvent.type(screen.getByLabelText('Current Password'), 'supersecret');
    await userEvent.type(screen.getByLabelText('New Password'), 'brand-new-secret');
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'brand-new-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText(/No other sessions were signed in\./)).toBeInTheDocument();
  });

  it('requires both passwords before calling the API', async () => {
    await openSecurity();
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText('Enter your current and new password.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('catches a mismatched confirmation before calling the API', async () => {
    await openSecurity();
    await userEvent.type(screen.getByLabelText('Current Password'), 'supersecret');
    await userEvent.type(screen.getByLabelText('New Password'), 'brand-new-secret');
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'different-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText('The new passwords do not match.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('catches a too-short password before calling the API', async () => {
    await openSecurity();
    await userEvent.type(screen.getByLabelText('Current Password'), 'supersecret');
    await userEvent.type(screen.getByLabelText('New Password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText('Password must be at least 8 characters.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('surfaces a rejected current password from the server', async () => {
    (api.put as any).mockRejectedValue(new Error('Current password is incorrect.'));
    await openSecurity();
    await userEvent.type(screen.getByLabelText('Current Password'), 'wrong');
    await userEvent.type(screen.getByLabelText('New Password'), 'brand-new-secret');
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'brand-new-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
  });

  it('signs out everywhere after confirming', async () => {
    (api.post as any).mockResolvedValue({ ended: 3 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openSecurity();
    await userEvent.click(screen.getByRole('button', { name: 'Sign Out Everywhere' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/logout-all', {}));
    expect(await screen.findByText(/Signed out 3 other sessions\./)).toBeInTheDocument();
  });

  it('does nothing when the sign-out confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openSecurity();
    await userEvent.click(screen.getByRole('button', { name: 'Sign Out Everywhere' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('surfaces a sign-out failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.post as any).mockRejectedValue(new Error('logout boom'));
    await openSecurity();
    await userEvent.click(screen.getByRole('button', { name: 'Sign Out Everywhere' }));
    expect(await screen.findByText('logout boom')).toBeInTheDocument();
  });
});
