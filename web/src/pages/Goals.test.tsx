import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Goals from './Goals';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const savingsGoal = {
  id: 1, name: 'Emergency Fund', goal_type: 'savings' as const,
  target_amount: 10000, current_amount: 4000, baseline_amount: null, period: null,
  account_id: 5, category_id: null, liability_id: null, asset_id: null,
  target_date: '2026-12-31', status: 'active' as const, notes: 'Keep going',
  account_name: 'Savings Acct', category_name: null, liability_name: null, asset_name: null,
  progress: { current: 4000, target: 10000, pct: 40, remaining: 6000, state: 'on_track' as const },
};
const achievedGoal = {
  ...savingsGoal, id: 2, name: 'Vacation', account_id: null, asset_id: 9, account_name: null, asset_name: 'Art',
  target_date: null, notes: null,
  progress: { current: 10000, target: 10000, pct: 100, remaining: 0, state: 'achieved' as const },
};
const reduceGoal = {
  id: 3, name: 'Eat Out Less', goal_type: 'reduce_spending' as const,
  target_amount: 300, current_amount: null, baseline_amount: null, period: 'monthly',
  account_id: null, category_id: 12, liability_id: null, asset_id: null,
  target_date: null, status: 'active' as const, notes: null,
  account_name: null, category_name: 'Dining', liability_name: null, asset_name: null,
  progress: { current: 350, target: 300, pct: 117, remaining: -50, state: 'over' as const, period: 'monthly', windowLabel: 'Sep 2026' },
};
const debtGoal = {
  id: 4, name: 'Pay Card', goal_type: 'debt_payoff' as const,
  target_amount: 0, current_amount: null, baseline_amount: 5000, period: null,
  account_id: null, category_id: null, liability_id: 3, asset_id: null,
  target_date: null, status: 'active' as const, notes: null,
  account_name: null, category_name: null, liability_name: 'Visa', asset_name: null,
  progress: { current: 2000, target: 0, pct: 60, remaining: 2000, state: 'on_track' as const, paid: 3000, baseline: 5000 },
};
const archivedGoal = {
  ...savingsGoal, id: 5, name: 'Old Goal', status: 'archived' as const,
  account_id: null, account_name: null, target_date: null, notes: null,
};

const lookups = {
  '/accounts': [
    { id: 5, name: 'Savings Acct', is_liability: false, latest_balance: 4000 },
    { id: 6, name: 'Credit Card', is_liability: true, latest_balance: -1500 },
  ],
  '/assets': [{ id: 9, name: 'Art', value: 12000 }],
  '/liabilities': [{ id: 3, name: 'Visa', balance: 2000 }],
  '/categories': [
    { id: 10, name: 'Food', kind: 'expense', parent_id: null, has_children: true, sort_order: 1 },
    { id: 12, name: 'Dining', kind: 'expense', parent_id: 10, has_children: false, sort_order: 1 },
    { id: 20, name: 'Income', kind: 'income', parent_id: null, has_children: false, sort_order: 1 },
  ],
};

const allGoals = [savingsGoal, achievedGoal, reduceGoal, debtGoal, archivedGoal];

function mockGet(goals: any[] = allGoals) {
  (api.get as any).mockImplementation((path: string) => {
    if (path.startsWith('/goals')) return Promise.resolve(goals);
    return Promise.resolve((lookups as any)[path] ?? []);
  });
}

const renderPage = () => render(<MemoryRouter><Goals /></MemoryRouter>);

// The Modal renders inside a `.scrim` element — scope editor queries to it so the
// modal's "Add Goal" save button never collides with the page's head-add button.
const modal = () => document.querySelector('.scrim') as HTMLElement;
const openEditor = async () => {
  await userEvent.click(document.querySelector('.head-add') as HTMLElement);
  await waitFor(() => expect(document.querySelector('.scrim')).toBeInTheDocument());
};
const saveBtn = (label: string) => within(modal()).getByRole('button', { name: label });

describe('Goals page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders summary stats and all four goal-type cards + archived', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    // Summary stat cards.
    expect(screen.getByText('Active goals').closest('.card')!.querySelector('.value')!.textContent).toBe('4');
    expect(screen.getByText('Achieved').closest('.card')!.querySelector('.value')!.textContent).toBe('1');
    expect(screen.getByText('Off track').closest('.card')!.querySelector('.value')!.textContent).toBe('1');
    // Savings line (appears on both Emergency Fund and its archived clone).
    const efCard = screen.getByText('Emergency Fund').closest('.card') as HTMLElement;
    expect(within(efCard).getByText('$4,000.00 of $10,000.00')).toBeInTheDocument();
    expect(within(efCard).getByText('$6,000.00 to go')).toBeInTheDocument();
    // Achieved goal shows the reached text
    expect(screen.getByText('Goal reached 🎉')).toBeInTheDocument();
    // Reduce-spending over-cap text
    expect(screen.getByText(/Over by \$50\.00/)).toBeInTheDocument();
    // Debt payoff line
    expect(screen.getByText('$2,000.00 left to pay')).toBeInTheDocument();
    // Linked labels
    expect(screen.getByText('Account: Savings Acct')).toBeInTheDocument();
    expect(screen.getByText('Asset: Art')).toBeInTheDocument();
    expect(screen.getByText('Debt: Visa')).toBeInTheDocument();
    expect(screen.getByText('Category: Dining')).toBeInTheDocument();
    // Archived section
    expect(screen.getByText('Old Goal')).toBeInTheDocument();
    // Target date + notes on first card
    expect(screen.getByText(/Target date:/)).toBeInTheDocument();
    expect(screen.getByText('Keep going')).toBeInTheDocument();
  });

  it('shows the empty state when there are no goals', async () => {
    mockGet([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No goals yet/)).toBeInTheDocument());
  });

  it('shows the no-active-goals sub-state when only archived exist', async () => {
    mockGet([archivedGoal]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No active goals/)).toBeInTheDocument());
  });

  it('surfaces an error when the goals load fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path.startsWith('/goals') ? Promise.reject(new Error('goals boom')) : Promise.resolve([]));
    renderPage();
    await waitFor(() => expect(screen.getByText('goals boom')).toBeInTheDocument());
  });

  it('deletes a goal (confirmed) and archives/reactivates', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    const card = screen.getByText('Emergency Fund').closest('.card') as HTMLElement;
    await userEvent.click(within(card).getByText('Delete'));
    expect(api.del).toHaveBeenCalledWith('/goals/1');
    await userEvent.click(within(card).getByText('Archive'));
    expect(api.put).toHaveBeenCalledWith('/goals/1', { status: 'archived' });
    // Reactivate on the archived card.
    const arch = screen.getByText('Old Goal').closest('.card') as HTMLElement;
    await userEvent.click(within(arch).getByText('Reactivate'));
    expect(api.put).toHaveBeenCalledWith('/goals/5', { status: 'active' });
  });

  it('does not delete when confirm is cancelled', async () => {
    (window.confirm as any).mockReturnValue(false);
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    const card = screen.getByText('Emergency Fund').closest('.card') as HTMLElement;
    await userEvent.click(within(card).getByText('Delete'));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('creates a new savings goal via the editor', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    // Save stays disabled until the form is dirty.
    expect(saveBtn('Add Goal')).toBeDisabled();
    // Fill name + target.
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'New Fund');
    await userEvent.type(screen.getByPlaceholderText('10000'), '5000');
    await userEvent.click(saveBtn('Add Goal'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/goals', expect.objectContaining({
      goal_type: 'savings', target_amount: 5000, name: 'New Fund',
    })));
  });

  it('shows a validation error when target amount is missing (savings)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'X');
    await userEvent.click(saveBtn('Add Goal'));
    expect(await screen.findByText('Set a target amount.')).toBeInTheDocument();
  });

  it('savings via account source selector', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Acct Goal');
    await userEvent.type(screen.getByPlaceholderText('10000'), '5000');
    // Switch to Account source.
    await userEvent.selectOptions(screen.getByDisplayValue('Enter Manually'), 'account');
    await userEvent.selectOptions(within(modal()).getByText('Select…').closest('select')!, '5');
    await userEvent.click(saveBtn('Add Goal'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/goals', expect.objectContaining({ account_id: 5 })));
  });

  it('savings via asset source selector', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Asset Goal');
    await userEvent.type(screen.getByPlaceholderText('10000'), '5000');
    await userEvent.selectOptions(screen.getByDisplayValue('Enter Manually'), 'asset');
    await userEvent.selectOptions(within(modal()).getByText('Select…').closest('select')!, '9');
    await userEvent.click(saveBtn('Add Goal'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/goals', expect.objectContaining({ asset_id: 9 })));
  });

  it('edits an existing reduce_spending goal (PUT)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Eat Out Less')).toBeInTheDocument());
    const card = screen.getByText('Eat Out Less').closest('.card') as HTMLElement;
    await userEvent.click(within(card).getByText('Edit'));
    await waitFor(() => expect(within(modal()).getByText('Edit Goal')).toBeInTheDocument());
    const nameInput = within(modal()).getByDisplayValue('Eat Out Less');
    await userEvent.type(nameInput, '!');
    await userEvent.click(saveBtn('Save Changes'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/goals/3', expect.objectContaining({
      goal_type: 'reduce_spending', category_id: 12, target_amount: 300, period: 'monthly',
    })));
  });

  it('validates the reduce_spending required fields', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Cap');
    await userEvent.selectOptions(within(modal()).getByDisplayValue('Savings'), 'reduce_spending');
    await userEvent.click(saveBtn('Add Goal'));
    expect(await screen.findByText('Pick a category to cap.')).toBeInTheDocument();
    // Pick a category (whole group option), then still missing cap.
    await userEvent.selectOptions(within(modal()).getByText('Select…').closest('select')!, '10');
    await userEvent.click(saveBtn('Add Goal'));
    expect(await screen.findByText('Set a spending cap.')).toBeInTheDocument();
  });

  it('creates a debt_payoff goal linked to a liability', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Kill Debt');
    await userEvent.selectOptions(within(modal()).getByDisplayValue('Savings'), 'debt_payoff');
    // Debt validation when nothing linked.
    await userEvent.click(saveBtn('Add Goal'));
    expect(await screen.findByText(/Link a debt account or liability/)).toBeInTheDocument();
    // Pick the liability (value liab:3).
    await userEvent.selectOptions(within(modal()).getByDisplayValue('Not linked — enter manually'), 'liab:3');
    await userEvent.click(saveBtn('Add Goal'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/goals', expect.objectContaining({ liability_id: 3 })));
  });

  it('creates a debt_payoff goal linked to a liability account (acct:)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Card Debt');
    await userEvent.selectOptions(within(modal()).getByDisplayValue('Savings'), 'debt_payoff');
    await userEvent.selectOptions(within(modal()).getByDisplayValue('Not linked — enter manually'), 'acct:6');
    await userEvent.click(saveBtn('Add Goal'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/goals', expect.objectContaining({ account_id: 6 })));
  });

  it('creates a debt_payoff goal with a manual current balance', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Manual Debt');
    await userEvent.selectOptions(within(modal()).getByDisplayValue('Savings'), 'debt_payoff');
    await userEvent.type(screen.getByPlaceholderText('e.g. 8500'), '8500');
    await userEvent.click(saveBtn('Add Goal'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/goals', expect.objectContaining({ current_amount: 8500 })));
  });

  it('surfaces a save error from the server', async () => {
    (api.post as any).mockRejectedValue(new Error('save boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    // Make the form dirty via the target amount (name still blank) -> name-required branch.
    await userEvent.type(screen.getByPlaceholderText('10000'), '5000');
    await userEvent.click(saveBtn('Add Goal'));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    // Now provide a name and trigger the server error.
    await userEvent.type(screen.getByPlaceholderText('e.g. Emergency fund'), 'Err Goal');
    await userEvent.click(saveBtn('Add Goal'));
    expect(await screen.findByText('save boom')).toBeInTheDocument();
  });

  it('closes the editor without saving', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Emergency Fund')).toBeInTheDocument());
    await openEditor();
    await userEvent.click(within(modal()).getByText('Close'));
    await waitFor(() => expect(screen.queryByPlaceholderText('e.g. Emergency fund')).toBeNull());
  });
});
