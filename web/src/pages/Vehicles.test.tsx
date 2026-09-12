import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';

const navMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navMock };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

import Vehicles, {
  VehicleDisposeFields,
  blankDisposeForm,
  vehicleTitle, vehicleSubtitle, milesDrivenOf, equityOf, depreciationOf, depreciationPctOf,
  monthsOwnedOf, monthlyCostOf, costPerMileOf, estAnnualMilesOf, vinTail, fuelShort, daysSince,
  warningsOf, isDisposed, loanOf,
  type Vehicle, type DisposeForm,
} from './Vehicles';

// A blank vehicle with sensible nulls; override per test.
const mk = (over: Partial<Vehicle>): Vehicle => ({
  id: 1, name: 'Car', make: null, model: null, year: null, vin: null,
  purchase_date: null, purchase_price: null, current_value: null,
  odometer_start: null, odometer_current: null,
  ...over,
});

const ownedFull: Vehicle = mk({
  id: 1, name: 'Daily Driver', make: 'Toyota', model: 'Tacoma', year: 2021,
  vin: 'JT1ABCDEF123456', purchase_date: '2021-01-15', purchase_price: 40000,
  current_value: 30000, odometer_start: 10000, odometer_current: 40000,
  fuel_type: 'Gasoline', total_spent: 6000, last_odometer_at: '2026-09-01',
  loan_account_id: 5, loan_account_balance: 8000, doc_count: 3,
});

const ownedMissing: Vehicle = mk({
  id: 2, name: 'Project Car', make: 'Ford', model: 'Mustang', year: 2000,
  // missing current_value, purchase_price, vin, odometer -> warnings
});

const ownedOutright: Vehicle = mk({
  id: 3, name: 'Runabout', make: 'Honda', model: 'Civic', year: 2019,
  vin: 'HND999888777666', purchase_date: '2019-06-01', purchase_price: 20000,
  current_value: 12000, odometer_start: 5000, odometer_current: 60000,
  fuel_type: 'Diesel', total_spent: 3000, last_odometer_at: '2026-01-01',
});

const disposedVeh: Vehicle = mk({
  id: 4, name: 'Old Truck', make: 'Chevy', model: 'Silverado', year: 2010,
  vin: 'CHV111222333444', purchase_date: '2012-01-01', purchase_price: 25000,
  current_value: null, odometer_start: 0, odometer_current: 150000,
  fuel_type: 'Electric', total_spent: 4000,
  disposed_at: '2024-03-01', disposal_type: 'sold', disposal_amount: 9000,
});

const fixtures: Record<string, any> = {
  '/vehicles': [ownedFull, ownedMissing, ownedOutright, disposedVeh],
  '/vehicles/miles-driven': [
    { month: '2026-01', miles: 900 },
    { month: '2026-02', miles: 1100 },
    { month: '2026-03', miles: 1000 },
  ],
};

const renderPage = () => render(<MemoryRouter initialEntries={['/vehicles']}><Vehicles /></MemoryRouter>);

beforeEach(() => {
  navMock.mockReset();
  localStorage.clear();
  (api.get as any).mockImplementation((path: string) => Promise.resolve(fixtures[path] ?? {}));
});

describe('Vehicles page', () => {
  it('renders the loaded list with owned and previously-owned cards', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Vehicles')).toBeInTheDocument());
    // Owned card title (also appears in the chart legend/axis).
    expect(screen.getAllByText('2021 Toyota Tacoma').length).toBeGreaterThan(0);
    // Summary cards
    expect(screen.getAllByText('Current Value').length).toBeGreaterThan(0);
    expect(screen.getByText('Vehicle Equity')).toBeInTheDocument();
    expect(screen.getAllByText('Net Depreciation').length).toBeGreaterThan(0);
    // Warnings appear for the project car
    expect(screen.getAllByText(/Needs attention/).length).toBeGreaterThan(0);
    // Mileage trend
    expect(screen.getByText('Mileage Trend')).toBeInTheDocument();
  });

  it('shows the empty state when there are no vehicles', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/vehicles' ? Promise.resolve([]) : Promise.resolve([]));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No vehicles yet/)).toBeInTheDocument());
  });

  it('shows an error when the vehicles request fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/vehicles' ? Promise.reject(new Error('boom')) : Promise.resolve([]));
    renderPage();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('toggles the charts visibility (persists to localStorage)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Mileage Trend')).toBeInTheDocument());
    await user.click(screen.getByText('Hide Charts'));
    expect(localStorage.getItem('vehicles.hideCharts')).toBe('1');
    expect(screen.queryByText('Mileage Trend')).not.toBeInTheDocument();
    await user.click(screen.getByText('Show Charts'));
    expect(localStorage.getItem('vehicles.hideCharts')).toBe('0');
    await waitFor(() => expect(screen.getByText('Mileage Trend')).toBeInTheDocument());
  });

  it('cycles through all the filters', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText('2021 Toyota Tacoma').length).toBeGreaterThan(0));
    const select = screen.getByRole('combobox');
    for (const val of ['all', 'previous', 'financed', 'outright', 'missing', 'missing_value', 'missing_odometer', 'owned']) {
      await user.selectOptions(select, val);
    }
    // Back on owned; the owned card is present again.
    await waitFor(() => expect(screen.getAllByText('2021 Toyota Tacoma').length).toBeGreaterThan(0));
  });

  it('renders the single-value chart branch when only one vehicle has a value', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/vehicles' ? Promise.resolve([ownedFull, ownedMissing])
        : path === '/vehicles/miles-driven' ? Promise.resolve([])
        : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getByText('Value by Vehicle')).toBeInTheDocument());
    // Single value -> the vehicle title appears in the single-bar block.
    expect(screen.getAllByText('2021 Toyota Tacoma').length).toBeGreaterThan(0);
    // Missing-value note.
    expect(screen.getByText(/missing a current value/)).toBeInTheDocument();
  });

  it('shows the no-value chart message when nothing has a value', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/vehicles' ? Promise.resolve([ownedMissing])
        : path === '/vehicles/miles-driven' ? Promise.resolve([])
        : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No vehicles have a current value yet/)).toBeInTheDocument());
    expect(screen.getByText(/compare value retained/)).toBeInTheDocument();
  });

  it('shows the mileage-trend empty hint when there is no miles data but active vehicles exist', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/vehicles' ? Promise.resolve([ownedFull])
        : path === '/vehicles/miles-driven' ? Promise.resolve([])
        : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Add at least two odometer readings/)).toBeInTheDocument());
  });

  it('toggles the Previously Owned section', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Previously Owned Vehicles/)).toBeInTheDocument());
    // Collapsed by default -> the Show button.
    const showBtn = screen.getByRole('button', { name: 'Show' });
    await user.click(showBtn);
    expect(localStorage.getItem('vehicles.showPreviouslyOwned')).toBe('1');
    // Now the disposed vehicle card is visible in the section.
    await waitFor(() => expect(screen.getAllByText('2010 Chevy Silverado').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(localStorage.getItem('vehicles.showPreviouslyOwned')).toBe('0');
  });

  it('navigates when Add Vehicle is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Add Vehicle')).toBeInTheDocument());
    await user.click(screen.getByText('Add Vehicle'));
    expect(navMock).toHaveBeenCalledWith('/vehicles/new');
  });

  it('navigates to a vehicle detail when a card is opened', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText('2021 Toyota Tacoma').length).toBeGreaterThan(0));
    const buttons = screen.getAllByRole('button', { name: /View Details/ });
    await user.click(buttons[0]);
    expect(navMock).toHaveBeenCalledWith(expect.stringMatching(/^\/vehicles\/\d+$/));
  });

  it('deep-links to the add form from the Asset Dashboard state', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/vehicles', state: { add: true } }]}>
        <Vehicles />
      </MemoryRouter>,
    );
    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/vehicles/new', { replace: true, state: null }));
  });

  it('shows the no-match message when a filter excludes everything', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation((path: string) =>
      path === '/vehicles' ? Promise.resolve([ownedOutright])
        : path === '/vehicles/miles-driven' ? Promise.resolve([])
        : Promise.resolve({}));
    renderPage();
    await waitFor(() => expect(screen.getAllByText('2019 Honda Civic').length).toBeGreaterThan(0));
    await user.selectOptions(screen.getByRole('combobox'), 'financed');
    await waitFor(() => expect(screen.getByText('No vehicles match this filter.')).toBeInTheDocument());
  });
});

describe('Vehicles pure helpers', () => {
  it('vehicleTitle / vehicleSubtitle', () => {
    expect(vehicleTitle(ownedFull)).toBe('2021 Toyota Tacoma');
    expect(vehicleTitle(mk({ name: 'Just A Name' }))).toBe('Just A Name');
    expect(vehicleSubtitle(ownedFull)).toContain('VIN');
    expect(vehicleSubtitle(mk({ name: '2024 Jeep Wrangler', year: null, make: null, model: null }))).toBe('');
  });

  it('milesDrivenOf / equityOf / depreciationOf / pct', () => {
    expect(milesDrivenOf(ownedFull)).toBe(30000);
    expect(milesDrivenOf(mk({}))).toBeNull();
    expect(equityOf(ownedFull)).toBe(30000 - 8000);
    expect(equityOf(mk({}))).toBeNull();
    expect(depreciationOf(ownedFull)).toBe(10000);
    expect(depreciationOf(mk({}))).toBeNull();
    expect(depreciationPctOf(ownedFull)).toBeCloseTo(25);
    expect(depreciationPctOf(mk({}))).toBeNull();
  });

  it('monthsOwnedOf / monthlyCostOf / costPerMileOf / estAnnualMilesOf', () => {
    expect(monthsOwnedOf(mk({}))).toBeNull();
    expect(monthsOwnedOf(ownedFull)).toBeGreaterThan(0);
    expect(monthlyCostOf(ownedFull)).not.toBeNull();
    expect(monthlyCostOf(mk({}))).toBeNull();
    expect(costPerMileOf(ownedFull)).not.toBeNull();
    expect(costPerMileOf(mk({ total_spent: 100 }))).toBeNull();
    expect(estAnnualMilesOf(ownedFull)).not.toBeNull();
    expect(estAnnualMilesOf(mk({}))).toBeNull();
    // Disposed months use disposed_at as the end.
    expect(monthsOwnedOf(disposedVeh)).toBeGreaterThan(0);
  });

  it('vinTail / fuelShort / daysSince', () => {
    expect(vinTail(ownedFull)).toBe('123456');
    expect(vinTail(mk({}))).toBeNull();
    expect(fuelShort(mk({ fuel_type: 'Gasoline' }))).toBe('Gas');
    expect(fuelShort(mk({ fuel_type: 'Diesel' }))).toBe('Diesel');
    expect(fuelShort(mk({ fuel_type: 'Electric' }))).toBe('Electric');
    expect(fuelShort(mk({ fuel_type: 'Plug-in Hybrid' }))).toBe('Hybrid');
    expect(fuelShort(mk({ fuel_type: 'Hydrogen' }))).toBe('Hydrogen');
    expect(fuelShort(mk({ fuel_type: null }))).toBeNull();
    expect(daysSince(null)).toBeNull();
    expect(daysSince('2000-01-01')).toBeGreaterThan(0);
  });

  it('warningsOf / isDisposed / loanOf / blankDisposeForm', () => {
    expect(isDisposed(disposedVeh)).toBe(true);
    expect(isDisposed(ownedFull)).toBe(false);
    expect(warningsOf(disposedVeh)).toEqual([]);
    expect(warningsOf(ownedMissing)).toEqual(expect.arrayContaining(['Needs current value', 'Missing purchase price', 'Missing VIN', 'Missing odometer']));
    // Stale odometer warning.
    expect(warningsOf(mk({ current_value: 1, purchase_price: 1, vin: 'X', odometer_current: 1, last_odometer_at: '2000-01-01' })))
      .toContain('Odometer not updated in 60+ days');
    expect(loanOf(ownedFull)).toBe(8000);
    expect(loanOf(mk({}))).toBe(0);
    const df = blankDisposeForm(ownedFull);
    expect(df.disposal_type).toBe('sold');
    expect(blankDisposeForm(disposedVeh).disposal_amount).toBe('9000');
  });
});

describe('VehicleDisposeFields', () => {
  const dfixturesDF: Record<string, any> = {
    '/accounts': [
      { id: 1, name: 'Checking' },
      { id: 2, name: 'Old Savings', archived_at: '2020-01-01' },
    ],
    '/vehicles/1/proceeds-candidates': [
      { id: 10, txn_date: '2026-01-01', amount: 5000, direction: 'income', merchant: 'CarMax', description: null, account_name: 'Checking' },
    ],
  };

  function Host({ candidates = true }: { candidates?: boolean }) {
    const [form, setForm] = useState<DisposeForm>(blankDisposeForm(mk({ id: 1 })));
    return <VehicleDisposeFields vehicle={mk({ id: 1 })} form={form} setForm={setForm} onClose={onCloseMock} />;
  }
  const onCloseMock = vi.fn();

  beforeEach(() => {
    onCloseMock.mockReset();
    (api.get as any).mockImplementation((path: string) => Promise.resolve(dfixturesOf(path)));
  });

  const dfixturesOf = (path: string) => dfixturesDF[path] ?? {};

  it('renders proceeds modes and links transactions', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Host /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('How It Left')).toBeInTheDocument());

    // Change disposal type.
    const typeSelect = screen.getByText('How It Left').closest('label')!.querySelector('select')!;
    await user.selectOptions(typeSelect, typeSelect.querySelectorAll('option')[0].value);

    // proceeds_mode -> create shows Deposit Account.
    const modeSelect = screen.getByText('Record the Proceeds As').closest('label')!.querySelector('select')!;
    await user.selectOptions(modeSelect, 'create');
    await waitFor(() => expect(screen.getByText('Deposit Account')).toBeInTheDocument());
    // Non-archived account is present; archived one filtered out.
    expect(screen.getByRole('option', { name: 'Checking' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Old Savings' })).not.toBeInTheDocument();

    // proceeds_mode -> link shows Transaction select with candidates.
    await user.selectOptions(modeSelect, 'link');
    await waitFor(() => expect(screen.getByText('Transaction')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /CarMax/ })).toBeInTheDocument();

    // Cancel calls onClose.
    await user.click(screen.getByText('Cancel'));
    expect(onCloseMock).toHaveBeenCalled();
  });

  it('shows the empty candidate hint when no transactions can be linked', async () => {
    const user = userEvent.setup();
    (api.get as any).mockImplementation((path: string) =>
      path === '/accounts' ? Promise.resolve(dfixturesDF['/accounts']) : Promise.resolve([]));
    render(<MemoryRouter><Host candidates={false} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('How It Left')).toBeInTheDocument());
    const modeSelect = screen.getByText('Record the Proceeds As').closest('label')!.querySelector('select')!;
    await user.selectOptions(modeSelect, 'link');
    await waitFor(() => expect(screen.getByText(/No income\/transfer transactions found/)).toBeInTheDocument());
  });
});
