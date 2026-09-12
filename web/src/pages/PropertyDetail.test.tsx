import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PropertyDetail from './PropertyDetail';
import type { Property } from './Properties';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const baseProp = (over: Partial<Property> = {}): Property => ({
  id: 1, name: 'Test House', address: '1 Elm St', city: 'Metropolis', state: 'NY', zip: '10001',
  property_type: 'single_family',
  purchase_date: '2020-01-01', purchase_price: 300000, current_value: 400000,
  mortgage_balance: null, mortgage_account_id: 9, mortgage_account_name: 'Home Loan', mortgage_account_balance: 150000,
  year_built: 1995, square_feet: 2200, lot_size_acres: 0.3, bedrooms: 4, bathrooms: 2.5, stories: 2, garage_spaces: 2,
  is_new_construction: false, rental_income: 2000, is_rental: true, is_occupied: true, tenant_name: 'Bob Renter',
  lease_start: '2023-01-01', lease_end: '2030-01-01', security_deposit: 2000, legal_description: 'Lot 5',
  property_tax_annual: 3600, hoa_dues: 100, hoa_cycle: 'monthly', notes: 'notes here',
  disposed_at: null, disposal_type: null, disposal_amount: null, disposal_note: null,
  total_spent: 500, txn_count: 3, doc_count: 1,
  ...over,
});

const summary = (p: Property) => ({
  property: p,
  byCategory: [{ category_name: 'Repairs', total: 500, count: 2 }],
  totalSpent: 500, totalIncome: 1200, net: 700, monthsOwned: 24, costPerMonth: 100,
  equity: 250000, appreciation: 100000, annualRentalIncome: 24000, grossYield: 0.05,
});

const postedTxn = {
  id: 100, account_id: 1, category_id: 1, transfer_account_id: null, txn_date: '2026-02-01',
  posted_date: '2026-02-02', amount: 120, principal_amount: null, interest_category_id: null,
  direction: 'expense' as const, merchant: 'Hardware Store', description: null, purchaser: null,
  channel: null, source: null, category_name: 'Repairs', account_name: 'Checking',
  transfer_account_name: null, has_receipt: false, tags: [], splits: [], has_splits: false,
};

const values = [
  { id: 1, as_of: '2026-01-01', value: 380000 },
  { id: 2, as_of: '2026-06-01', value: 400000 },
];

// Build a path->response map for a given property + maintenance list.
const makeFixtures = (prop: Property | null, maint: any[] = []) => (path: string): Promise<any> => {
  if (path === '/properties') return Promise.resolve(prop ? [prop] : []);
  if (path.startsWith('/transactions?')) return Promise.resolve({ pending: [], pendingTotal: 0, posted: [postedTxn], total: 1 });
  const map: Record<string, any> = {
    '/properties/1/values': values,
    '/properties/1/summary': prop ? summary(prop) : {},
    '/properties/1/documents': [],
    '/properties/1/maintenance': maint,
    '/properties/1/expense-candidates': [
      { id: 55, txn_date: '2026-02-01', amount: 120, merchant: 'ABC Plumbing', description: null, account_name: 'Checking' },
    ],
    '/transactions/merchants': [],
  };
  if (path in map) return Promise.resolve(map[path]);
  return Promise.resolve([]);
};

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/properties/:propertyId" element={<PropertyDetail />} />
        <Route path="/properties" element={<div>PropsList</div>} />
        <Route path="/accounts" element={<div>AccountsPage</div>} />
      </Routes>
    </MemoryRouter>,
  );

const clickTab = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  // Capability tabs (Rental, Mortgage, …) only appear once the property has loaded,
  // and the page heading renders before that — so wait for the tab itself.
  await user.click(await screen.findByRole('button', { name: label }));
};

describe('PropertyDetail', () => {
  beforeEach(() => {
    (api.get as any).mockReset();
    (api.post as any).mockReset().mockResolvedValue({});
    (api.put as any).mockReset().mockResolvedValue({});
    (api.del as any).mockReset().mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows a loading state before data arrives', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderAt('/properties/1');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows not-found when the property is missing', async () => {
    (api.get as any).mockImplementation(makeFixtures(null));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByText('Property not found.')).toBeInTheDocument());
  });

  it('shows an invalid message for a non-numeric id', async () => {
    (api.get as any).mockImplementation(makeFixtures(null));
    renderAt('/properties/abc');
    await waitFor(() => expect(screen.getByText('Invalid property.')).toBeInTheDocument());
  });

  it('renders the Add Property form in new mode', async () => {
    (api.get as any).mockImplementation(makeFixtures(null));
    renderAt('/properties/new');
    expect(screen.getByRole('heading', { name: 'Add Property' })).toBeInTheDocument();
    expect(screen.getByText('New Property')).toBeInTheDocument();
  });

  it('estimates a value in the new-property form', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(null));
    (api.post as any).mockResolvedValue({ value: 350000, low: 340000, high: 360000, rationale: 'good area', source: 'rentcast' });
    renderAt('/properties/new');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/estimate-value', expect.any(Object)));
    expect(await screen.findByText(/Estimated .*RentCast/)).toBeInTheDocument();
  });

  it('renders the overview with rental tag, summary, and analysis', async () => {
    const user = userEvent.setup();
    const prop = baseProp();
    (api.get as any).mockImplementation(makeFixtures(prop));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    expect(screen.getByText(/Rental · Occupied/)).toBeInTheDocument();
    expect(screen.getByText('Cost & Performance')).toBeInTheDocument();
    expect(screen.getByText('Repairs')).toBeInTheDocument();
    expect(screen.getByText('Gross Yield')).toBeInTheDocument();
    // Run Analysis (success).
    (api.post as any).mockResolvedValueOnce({ result: '# Analysis done' });
    await user.click(screen.getByRole('button', { name: 'Run Analysis' }));
    await waitFor(() => expect(screen.getByText('Analysis done')).toBeInTheDocument());
  });

  it('surfaces an analysis error', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    (api.post as any).mockRejectedValueOnce(new Error('analysis boom'));
    await user.click(screen.getByRole('button', { name: 'Run Analysis' }));
    await waitFor(() => expect(screen.getByText('analysis boom')).toBeInTheDocument());
  });

  it('renders a vacant, mortgage-paid-off, non-rental variant', async () => {
    const prop = baseProp({ is_rental: false, is_occupied: false, mortgage_account_balance: 0, current_value: null, purchase_price: null });
    (api.get as any).mockImplementation(makeFixtures(prop));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    // Mortgage account at $0 -> Paid off in the overview grid.
    expect(screen.getAllByText('Paid off').length).toBeGreaterThan(0);
  });

  it('adds, estimates, and deletes value snapshots', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Value');
    // Add a snapshot: fill value, click Add Value.
    const amount = await screen.findByPlaceholderText('0.00');
    await user.type(amount, '410000');
    await user.click(screen.getByRole('button', { name: 'Add Value' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/1/values', expect.objectContaining({ value: 410000 })));
    // Estimate & Record (rentcast source).
    (api.post as any).mockImplementation((p: string) =>
      p === '/properties/estimate-value'
        ? Promise.resolve({ value: 420000, low: 410000, high: 430000, rationale: 'r', source: 'rentcast' })
        : Promise.resolve({}));
    await user.click(screen.getByRole('button', { name: 'Estimate & Record' }));
    await waitFor(() => expect(screen.getByText(/Estimated/)).toBeInTheDocument());
    // Delete a snapshot (first ✕).
    (api.post as any).mockResolvedValue({});
    const deletes = screen.getAllByTitle('Delete');
    await user.click(deletes[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(expect.stringContaining('/properties/1/values/')));
  });

  it('surfaces an estimate error on the value tab', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Value');
    (api.post as any).mockRejectedValueOnce(new Error('estimate boom'));
    await user.click(await screen.findByRole('button', { name: 'Estimate & Record' }));
    await waitFor(() => expect(screen.getByText('estimate boom')).toBeInTheDocument());
  });

  it('loads lookups then opens the transaction editor', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Transactions');
    // Posted txn row renders.
    expect(await screen.findByText('Hardware Store')).toBeInTheDocument();
    // Add Transaction becomes enabled once lookups load.
    const addBtn = await screen.findByRole('button', { name: 'Add Transaction' });
    await waitFor(() => expect(addBtn).toBeEnabled());
    await user.click(addBtn);
    // TxnEditor modal opens; close it.
    await waitFor(() => expect(document.querySelector('.scrim')).toBeTruthy());
    await user.click(document.querySelector('.scrim')!);
  });

  it('opens the transaction editor when a row is clicked', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Transactions');
    const row = await screen.findByText('Hardware Store');
    // Wait for lookups (row becomes clickable via onEdit).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Transaction' })).toBeEnabled());
    await user.click(row);
    await waitFor(() => expect(document.querySelector('.scrim')).toBeTruthy());
  });

  it('manages maintenance items (add, edit, mark complete, delete)', async () => {
    const user = userEvent.setup();
    const maint = [
      { id: 11, item: 'HVAC service', status: 'upcoming', service_date: null, cost: null, transaction_id: null, due_date: '2026-03-01', vendor: null, notes: 'note', txn_date: null, txn_amount: null, txn_merchant: null },
      { id: 12, item: 'Roof repair', status: 'completed', service_date: '2026-01-15', cost: 800, transaction_id: null, due_date: null, vendor: 'ABC Roofing', notes: null, txn_date: null, txn_amount: null, txn_merchant: null },
    ];
    (api.get as any).mockImplementation(makeFixtures(baseProp(), maint));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Maintenance');
    expect(await screen.findByText('HVAC service')).toBeInTheDocument();
    expect(screen.getByText('Roof repair')).toBeInTheDocument();

    // Add Upcoming: validation then success.
    await user.click(screen.getByRole('button', { name: 'Add Upcoming' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Describe the maintenance item.')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Roof repair, HVAC service/), 'Gutter cleaning');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/1/maintenance', expect.objectContaining({ item: 'Gutter cleaning' })));

    // Edit the upcoming item -> Mark Complete -> Save Changes (put).
    await user.click(screen.getByText('HVAC service'));
    await user.click(await screen.findByRole('button', { name: 'Mark Complete' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/properties/1/maintenance/11', expect.any(Object)));

    // Add Completed with a linked transaction (fills vendor).
    await user.click(screen.getByRole('button', { name: 'Add Completed' }));
    await user.type(screen.getByPlaceholderText(/Roof repair, HVAC service/), 'Painting');
    const linkSelect = await screen.findByRole('combobox', { name: '' }).catch(() => null);
    // Pick the expense candidate in the "Linked Transaction" select.
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[selects.length - 1], '55');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/1/maintenance', expect.objectContaining({ item: 'Painting', transaction_id: 55 })));

    // Delete a maintenance item.
    const rowDeletes = screen.getAllByTitle('Delete');
    await user.click(rowDeletes[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(expect.stringContaining('/properties/1/maintenance/')));
  });

  it('shows the maintenance empty state', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp(), []));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Maintenance');
    expect(await screen.findByText(/Nothing scheduled/)).toBeInTheDocument();
    expect(screen.getByText('No maintenance recorded yet.')).toBeInTheDocument();
  });

  it('renders the insurance and documents tabs', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Insurance');
    expect(await screen.findByText(/No insurance policies yet/)).toBeInTheDocument();
    await clickTab(user, 'Documents');
    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
  });

  it('edits rental details on the Rental tab', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Rental');
    expect(await screen.findByText('Rental Details')).toBeInTheDocument();
    // Change the tenant name and save.
    const tenant = screen.getByDisplayValue('Bob Renter');
    await user.clear(tenant);
    await user.type(tenant, 'New Tenant');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/properties/1', expect.objectContaining({ is_rental: true })));
  });

  it('edits and saves details, toggles rental, and deletes', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Details');
    // Change name -> Save enabled -> put.
    const name = await screen.findByDisplayValue('Test House');
    await user.clear(name);
    await user.type(name, 'Renamed House');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/properties/1', expect.objectContaining({ name: 'Renamed House' })));
    // Delete.
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/properties/1'));
    expect(await screen.findByText('PropsList')).toBeInTheDocument();
  });

  it('unlinks a mortgage account and opens accounts', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Details');
    expect(await screen.findByText('Managed as account')).toBeInTheDocument();
    // Open in Accounts navigates.
    await user.click(screen.getByRole('button', { name: 'Open in Accounts' }));
    expect(await screen.findByText('AccountsPage')).toBeInTheDocument();
  });

  it('sets up a mortgage account for an unlinked property', async () => {
    const user = userEvent.setup();
    const prop = baseProp({ mortgage_account_id: null, mortgage_account_name: null, mortgage_account_balance: null, mortgage_balance: 100000 });
    (api.get as any).mockImplementation(makeFixtures(prop));
    (api.post as any).mockResolvedValue({ id: 42, name: 'Mortgage', opening_balance: 100000 });
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Details');
    await user.click(await screen.findByRole('button', { name: 'Set Up Mortgage Account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/1/mortgage-account', expect.any(Object)));
  });

  it('unlinks a mortgage via the Unlink button', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Details');
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/properties/1/mortgage-account'));
  });

  it('marks a property as no longer owned', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Details');
    await user.click(await screen.findByRole('button', { name: 'No Longer Owned' }));
    // The dispose form appears with a "Sale Price (Optional)" field; just confirm.
    await user.click(screen.getByRole('button', { name: 'Mark as No Longer Owned' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/1/dispose', expect.objectContaining({ disposed: true })));
  });

  it('restores a disposed property', async () => {
    const user = userEvent.setup();
    const prop = baseProp({ disposed_at: '2024-01-01', disposal_type: 'sold', disposal_amount: 420000, disposal_note: 'sold it' });
    (api.get as any).mockImplementation(makeFixtures(prop));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    // Disposed banner shows.
    expect(screen.getByText(/No longer owned/)).toBeInTheDocument();
    await clickTab(user, 'Details');
    await user.click(await screen.findByRole('button', { name: 'Mark as Owned Again' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/properties/1/dispose', { disposed: false }));
  });

  it('falls back to Details when unchecking rental while on the Rental tab', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation(makeFixtures(baseProp()));
    renderAt('/properties/1');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Test House/ })).toBeInTheDocument());
    await clickTab(user, 'Details');
    // Uncheck "This is a rental property".
    const checkbox = await screen.findByRole('checkbox', { name: /This is a rental property/ });
    await user.click(checkbox);
    // The Rental tab button should disappear.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rental' })).not.toBeInTheDocument());
  });
});
