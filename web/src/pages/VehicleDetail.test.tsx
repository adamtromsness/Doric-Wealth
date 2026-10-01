import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Spy on navigate while keeping the rest of react-router-dom real (MemoryRouter,
// useParams, useLocation).
const navMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navMock };
});

// Keep the real pure helpers (money, shortDate, todayStr, …); mock only network `api`.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';
import VehicleDetail from './VehicleDetail';

const baseVehicle = {
  id: 1,
  name: 'Daily Driver',
  make: 'Toyota',
  model: 'Tacoma',
  year: 2021,
  vin: '1HGCM82633A123456',
  purchase_date: '2023-01-15',
  purchase_price: 30000,
  current_value: 25000,
  odometer_start: 10000,
  odometer_current: 20000,
  trim: 'SR5',
  vehicle_type: 'Truck',
  fuel_type: 'Gasoline',
  license_plate: 'ABC 1234',
  engine_type: '3.5L V6',
  transmission: '6-Speed Automatic',
  drivetrain: '4WD',
  exterior_color: 'Black',
  notes: 'runs great',
  disposed_at: null,
  disposal_type: null,
  disposal_amount: null,
  disposal_note: null,
  disposal_transaction_id: null,
  loan_account_id: 7,
  loan_account_name: 'Truck Loan',
  loan_account_balance: 12000,
  total_spent: 500,
  last_odometer_at: '2026-08-01',
  doc_count: 2,
};

const summary = {
  vehicle: baseVehicle,
  byCategory: [{ category_name: 'Fuel', total: 100, count: 2 }],
  totalSpent: 500,
  monthsOwned: 12,
  milesDriven: 1000,
  depreciation: 2000,
  costPerMonth: 40,
  costPerMile: 0.5,
  maintenanceCost: 200,
  maintenanceCount: 3,
};

const postedTxn = {
  id: 100, account_id: 1, category_id: 1, transfer_account_id: null,
  txn_date: '2026-06-01', posted_date: '2026-06-02', amount: 55.5,
  principal_amount: null, interest_category_id: null,
  direction: 'expense', merchant: 'Shell', description: 'gas', purchaser: null,
  channel: null, source: null, category_name: 'Fuel', account_name: 'Checking',
  transfer_account_name: null, has_receipt: false, tags: [], splits: [], has_splits: false,
};

const upcomingMaint = {
  id: 10, item: 'Oil change', status: 'upcoming',
  service_date: null, odometer: null, cost: null, transaction_id: null,
  due_date: '2026-12-01', due_odometer: 25000, vendor: null, notes: 'synthetic',
  txn_date: null, txn_amount: null, txn_merchant: null, doc_count: 0,
};
const completedMaint = {
  id: 11, item: 'Tire rotation', status: 'completed',
  service_date: '2026-05-01', odometer: 19000, cost: 80, transaction_id: null,
  due_date: null, due_odometer: null, vendor: 'Jiffy Lube', notes: null,
  txn_date: null, txn_amount: null, txn_merchant: null, doc_count: 1,
};

// Central fixture map. Individual tests override entries via `overrides`.
function makeGet(overrides: Record<string, any> = {}, vehicle: any = baseVehicle) {
  const fixtures: Record<string, any> = {
    '/vehicles': [vehicle],
    '/vehicles/1/summary': summary,
    '/vehicles/1/documents': [],
    '/vehicles/1/warranties': [],
    '/vehicles/1/odometer': [
      { id: 1, as_of: '2026-01-01', value: 15000 },
      { id: 2, as_of: '2026-06-01', value: 20000 },
    ],
    '/vehicles/1/values': [
      { id: 1, as_of: '2026-01-01', value: 28000 },
      { id: 2, as_of: '2026-06-01', value: 25000 },
    ],
    '/vehicles/1/maintenance': [],
    '/vehicles/1/expense-candidates': [],
    '/vehicles/1/proceeds-candidates': [],
    '/vehicles/loan-accounts': [],
    '/categories': [], '/accounts': [], '/properties': [], '/subscriptions': [], '/tags': [],
    '/transactions/merchants': [],
    '/auth/ai-settings': { configured: true },
    ...overrides,
  };
  return (path: string) => {
    if (path.startsWith('/transactions?')) {
      return Promise.resolve(overrides['__txns'] ?? { pending: [], pendingTotal: 0, posted: [postedTxn], total: 1 });
    }
    if (path.startsWith('/vehicles/decode/')) {
      return Promise.resolve(overrides['__decode'] ?? {
        vin: 'DECODED', make: 'Jeep', model: 'Wrangler', year: 2020, name: null,
        trim: 'Rubicon', vehicle_type: 'SUV', fuel_type: 'Gasoline', engine_type: 'V6',
        transmission: 'Auto', drivetrain: '4WD',
      });
    }
    if (path in fixtures) return Promise.resolve(fixtures[path]);
    return Promise.resolve([]);
  };
}

const renderAt = (entry = '/vehicles/1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/vehicles/:vehicleId" element={<VehicleDetail />} />
        <Route path="/vehicles" element={<div>VehiclesList</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  navMock.mockReset();
  (api.get as any).mockReset();
  (api.post as any).mockReset().mockResolvedValue({});
  (api.put as any).mockReset().mockResolvedValue({});
  (api.del as any).mockReset().mockResolvedValue({});
  (api.get as any).mockImplementation(makeGet());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('VehicleDetail — load / error / new states', () => {
  it('shows a loading state before data arrives', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderAt();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows "Vehicle not found." when the id is missing from the list', async () => {
    (api.get as any).mockImplementation(makeGet({ '/vehicles': [] }));
    renderAt();
    await waitFor(() => expect(screen.getByText('Vehicle not found.')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Back to Vehicles/ })).toBeInTheDocument();
  });

  it('shows "Invalid vehicle." for a non-numeric id', async () => {
    renderAt('/vehicles/abc');
    await waitFor(() => expect(screen.getByText('Invalid vehicle.')).toBeInTheDocument());
  });

  it('renders the Add Vehicle form in new mode', async () => {
    renderAt('/vehicles/new');
    expect(await screen.findByRole('heading', { name: 'Add Vehicle' })).toBeInTheDocument();
    expect(screen.getByText('New Vehicle')).toBeInTheDocument();
  });

  it('does not request a summary (or any per-vehicle data) in new mode', async () => {
    renderAt('/vehicles/new');
    await screen.findByRole('heading', { name: 'Add Vehicle' });
    const paths: string[] = (api.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(paths.filter((p) => /^\/vehicles\/(NaN|new)\b/.test(p))).toEqual([]);
  });
});

describe('VehicleDetail — overview & analysis', () => {
  it('renders the overview facts and cost-of-ownership summary', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Cost of Ownership')).toBeInTheDocument();
    // byCategory row
    expect(screen.getByText('Fuel')).toBeInTheDocument();
  });

  it('runs the AI cost-of-ownership analysis and renders the result', async () => {
    (api.post as any).mockResolvedValue({ result: '# Analysis done' });
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Run Analysis' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/analysis/vehicle/1/cost-of-ownership'),
    );
    await screen.findByText('Analysis done');
  });

  it('surfaces an error when the analysis fails', async () => {
    (api.post as any).mockRejectedValueOnce(new Error('analysis boom'));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Run Analysis' }));
    await screen.findByText('analysis boom');
  });
});

describe('VehicleDetail — value & odometer tabs (snapshots)', () => {
  it('adds and deletes a value snapshot', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Value' }));
    await screen.findByText('Value Snapshots');

    // Add row: date + amount + "Add Value"
    const amount = screen.getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '26000');
    await userEvent.click(screen.getByRole('button', { name: 'Add Value' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vehicles/1/values', expect.objectContaining({ value: 26000 })),
    );

    // Delete the first (latest) snapshot row.
    const delButtons = screen.getAllByTitle('Delete');
    await userEvent.click(delButtons[0]);
    await waitFor(() =>
      expect(api.del).toHaveBeenCalledWith(expect.stringMatching(/\/vehicles\/1\/values\/\d+/)),
    );
  });

  it('estimates & records a value and shows the range message', async () => {
    (api.post as any).mockImplementation((path: string) => {
      if (path === '/vehicles/estimate-value') {
        return Promise.resolve({ value: 15000, low: 14000, high: 16000, rationale: 'depreciated' });
      }
      return Promise.resolve({});
    });
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Value' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Estimate & Record' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vehicles/estimate-value', expect.any(Object)),
    );
    await screen.findByText(/Estimated/);
    expect(screen.getByText(/depreciated/)).toBeInTheDocument();
  });

  it('disables Estimate & Record and links to AI Settings when no AI key is configured', async () => {
    (api.get as any).mockImplementation(makeGet({ '/auth/ai-settings': { configured: false } }));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Value' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Estimate & Record' })).toBeDisabled());
    expect(screen.getByRole('link', { name: 'AI Settings' })).toHaveAttribute('href', '/integrations/ai');
    expect(api.post).not.toHaveBeenCalledWith('/vehicles/estimate-value', expect.anything());
  });

  it('disables the new-vehicle Estimate button when no AI key is configured', async () => {
    (api.get as any).mockImplementation(makeGet({ '/auth/ai-settings': { configured: false } }));
    renderAt('/vehicles/new');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Estimate' })).toBeDisabled());
    expect(screen.getByRole('link', { name: 'AI Settings' })).toBeInTheDocument();
  });

  it('shows an error when the value estimate fails', async () => {
    (api.post as any).mockImplementation((path: string) =>
      path === '/vehicles/estimate-value' ? Promise.reject(new Error('estimate boom')) : Promise.resolve({}),
    );
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Value' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Estimate & Record' }));
    await screen.findByText('estimate boom');
  });

  it('adds and deletes an odometer reading', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Odometer' }));
    await screen.findByText('Odometer Readings');

    const value = screen.getByPlaceholderText('35000');
    await userEvent.type(value, '21000');
    await userEvent.click(screen.getByRole('button', { name: 'Add Reading' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vehicles/1/odometer', expect.objectContaining({ reading: 21000 })),
    );

    const delButtons = screen.getAllByTitle('Delete');
    await userEvent.click(delButtons[0]);
    await waitFor(() =>
      expect(api.del).toHaveBeenCalledWith(expect.stringMatching(/\/vehicles\/1\/odometer\/\d+/)),
    );
  });
});

describe('VehicleDetail — transactions tab', () => {
  it('renders the posted transaction, opens the add editor and the row editor', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));

    // Lazy lookups resolve; "Add Transaction" becomes enabled.
    const addBtn = await screen.findByRole('button', { name: 'Add Transaction' });
    await waitFor(() => expect(addBtn).toBeEnabled());
    // Posted txn row shows the merchant.
    expect(screen.getByText('Shell')).toBeInTheDocument();

    // Open the add editor (a Modal), then close it.
    await userEvent.click(addBtn);
    const closes = await screen.findAllByText('Close');
    await userEvent.click(closes[0]);

    // Click the txn row to open the edit editor.
    await userEvent.click(screen.getByText('Shell'));
    await waitFor(() => expect(screen.getAllByText('Close').length).toBeGreaterThan(0));
  });

  it('shows the empty transactions state', async () => {
    (api.get as any).mockImplementation(makeGet({ __txns: { pending: [], pendingTotal: 0, posted: [], total: 0 } }));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await screen.findByText('No transactions tagged to this vehicle yet.');
  });

  it('renders pending transactions with the pending header', async () => {
    (api.get as any).mockImplementation(
      makeGet({ __txns: { pending: [{ ...postedTxn, id: 200, posted_date: null, merchant: 'Costco' }], pendingTotal: 1, posted: [], total: 0 } }),
    );
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await screen.findByText(/awaiting posting/);
    expect(screen.getByText('Costco')).toBeInTheDocument();
  });
});

describe('VehicleDetail — maintenance tab', () => {
  it('lists upcoming + completed and validates the add form', async () => {
    (api.get as any).mockImplementation(makeGet({ '/vehicles/1/maintenance': [upcomingMaint, completedMaint] }));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    await screen.findByText('Oil change');
    expect(screen.getByText('Tire rotation')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Upcoming' }));
    // Empty item -> validation error.
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await screen.findByText('Describe the maintenance item.');
    // Fill item + save -> POST.
    await userEvent.type(screen.getByPlaceholderText(/Oil change, tire rotation/), 'Brakes');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/vehicles/1/maintenance', expect.any(Object)));
  });

  it('edits an existing item and can Mark Complete', async () => {
    (api.get as any).mockImplementation(makeGet({ '/vehicles/1/maintenance': [upcomingMaint, completedMaint] }));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    // Open the upcoming item (row click).
    await userEvent.click(await screen.findByText('Oil change'));
    await screen.findByText('Mark Complete');
    await userEvent.click(screen.getByRole('button', { name: 'Mark Complete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/vehicles/1/maintenance/10', expect.any(Object)));
  });

  it('uploads and deletes a document on an existing maintenance item', async () => {
    (api.get as any).mockImplementation(
      makeGet({
        '/vehicles/1/maintenance': [completedMaint],
        '/vehicles/1/maintenance/11/documents': [{ id: 5, name: 'Receipt', file_name: 'r.pdf', file_mime: 'application/pdf', created_at: '2026-05-01' }],
      }),
    );
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    await userEvent.click(await screen.findByText('Tire rotation'));
    // Existing doc rendered.
    await screen.findByText('r.pdf');
    // Upload via hidden file input.
    const modal = screen.getByText('Upload Document').closest('label')!;
    const input = modal.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'invoice.pdf', { type: 'application/pdf' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vehicles/1/maintenance/11/documents', expect.any(Object)),
    );
    // Delete the doc (its ✕ button sits in the same row as the file link).
    const docRow = screen.getByText('r.pdf').closest('.row')!;
    await userEvent.click(within(docRow as HTMLElement).getByTitle('Delete'));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/vehicles/1/documents/5'));
  });

  it('deletes a maintenance item from the list', async () => {
    (api.get as any).mockImplementation(makeGet({ '/vehicles/1/maintenance': [completedMaint] }));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    await screen.findByText('Tire rotation');
    await userEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/vehicles/1/maintenance/11'));
  });

  it('toggles the status select to completed in a new item', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Completed' }));
    const typeSelect = await screen.findByDisplayValue('Completed (History)');
    await userEvent.selectOptions(typeSelect, 'upcoming');
    await userEvent.selectOptions(typeSelect, 'completed');
    expect(screen.getByDisplayValue('Completed (History)')).toBeInTheDocument();
  });
});

describe('VehicleDetail — insurance & documents tabs', () => {
  it('renders the insurance sub-panel', async () => {
    (api.get as any).mockImplementation(makeGet({ '/vehicles/1/insurance': [] }));
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Insurance' }));
    await screen.findByText(/No insurance policies yet/);
  });

  it('renders the documents sub-panel', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Documents' }));
    await screen.findByText('No documents yet.');
  });
});

describe('VehicleDetail — details tab', () => {
  it('decodes a VIN and fills the form', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Look Up' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/vehicles/decode/')));
    await screen.findByText(/Decoded:/);
  });

  it('saves changes to an existing vehicle', async () => {
    (api.put as any).mockResolvedValue(baseVehicle);
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    const name = await screen.findByDisplayValue('Daily Driver');
    await userEvent.type(name, ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/vehicles/1', expect.any(Object)));
  });

  it('deletes a vehicle and navigates back to the list', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/vehicles/1'));
    expect(navMock).toHaveBeenCalledWith('/vehicles');
  });

  it('adds a warranty row and persists it with Save Changes', async () => {
    (api.put as any).mockResolvedValue(baseVehicle);
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByRole('button', { name: '+ Add Warranty' }));
    await userEvent.type(screen.getByPlaceholderText('Powertrain'), 'Bumper');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/vehicles/1/warranties', expect.any(Object)));
  });

  it('links a loan account when the loan checkbox is set and saved', async () => {
    // Start from a vehicle with no linked loan so the checkbox appears.
    const noLoan = { ...baseVehicle, loan_account_id: null, loan_account_name: null, loan_account_balance: null };
    (api.get as any).mockImplementation(makeGet({ '/vehicles': [noLoan] }, noLoan));
    (api.put as any).mockResolvedValue(noLoan);
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByLabelText(/This vehicle has a loan/));
    await userEvent.type(screen.getByPlaceholderText('0.00'), '10000');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/vehicles/1/loan-account', expect.any(Object)));
  });

  it('unlinks an existing loan account', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/vehicles/1/loan-account'));
  });

  it('stages a disposal and applies it on Save Changes', async () => {
    (api.put as any).mockResolvedValue(baseVehicle);
    renderAt();
    await screen.findByRole('heading', { name: 'Daily Driver' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByRole('button', { name: 'No Longer Owned' }));
    // Dispose fields now render (How It Left select).
    await screen.findByText('How It Left');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/vehicles/1/dispose', expect.objectContaining({ disposed: true })));
  });
});

describe('VehicleDetail — disposed vehicle', () => {
  const disposed = {
    ...baseVehicle,
    disposed_at: '2026-07-01',
    disposal_type: 'sold',
    disposal_amount: 20000,
    disposal_note: 'sold to CarMax',
  };

  it('shows the disposed banner and can be restored', async () => {
    (api.get as any).mockImplementation(makeGet({ '/vehicles': [disposed] }, disposed));
    renderAt();
    await waitFor(() => expect(screen.getByText(/No longer owned/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as Owned Again' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/vehicles/1/dispose', { disposed: false }));
  });
});
