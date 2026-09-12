import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Properties, {
  isDisposedProp, mortgageOf, equityOf, addressLine, appreciationOf, appreciationPctOf,
  monthsOwnedOf, monthlyCostOf, daysSince, warningsOf, propertyDocTypeLabel,
  type Property,
} from './Properties';

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

// A fully-populated base property; override per test.
const baseProp = (over: Partial<Property> = {}): Property => ({
  id: 1, name: 'Prop 1', address: '123 Main St', city: 'Townsville', state: 'CA', zip: '90210',
  property_type: 'single_family',
  purchase_date: '2020-01-01', purchase_price: 300000, current_value: 400000,
  mortgage_balance: null, mortgage_account_id: null, mortgage_account_name: null, mortgage_account_balance: null,
  year_built: 1990, square_feet: 2000, lot_size_acres: 0.25, bedrooms: 3, bathrooms: 2, stories: 2, garage_spaces: 2,
  is_new_construction: false, rental_income: null, is_rental: false, is_occupied: null, tenant_name: null,
  lease_start: null, lease_end: null, security_deposit: null, legal_description: null,
  property_tax_annual: null, hoa_dues: null, hoa_cycle: null, notes: null,
  disposed_at: null, disposal_type: null, disposal_amount: null, disposal_note: null,
  total_spent: 1200, txn_count: 4, doc_count: 2,
  ...over,
});

const owned = baseProp({ id: 1, name: 'Owned Home', notes: 'nice place' });
const rental = baseProp({
  id: 2, name: 'Rental Unit', is_rental: true, is_occupied: true, rental_income: 1500,
  tenant_name: 'Jane Doe', lease_end: '2030-01-01', current_value: 250000, purchase_price: 200000,
});
const mortgaged = baseProp({
  id: 3, name: 'Mortgaged Home', mortgage_account_id: 9, mortgage_account_balance: 150000,
  current_value: 500000, purchase_price: 450000,
});
const vacantRental = baseProp({
  id: 4, name: 'Vacant Rental', is_rental: true, is_occupied: false, rental_income: 900,
  lease_end: '2020-01-01', current_value: null, purchase_price: null,
});
const disposed = baseProp({
  id: 5, name: 'Sold Home', disposed_at: '2024-06-01', disposal_type: 'sold',
  disposal_amount: 420000, purchase_price: 300000,
});

const renderPage = () => render(<MemoryRouter><Properties /></MemoryRouter>);

// A property's name shows both as its card title and (for charted props) in the
// chart legend — scope lookups to the card title element to stay unambiguous.
const cardTitle = (name: string) =>
  screen.getAllByText(name).find((el) => el.classList.contains('title'))!;

const setFixtures = (props: Property[]) => {
  (api.get as any).mockImplementation((path: string) =>
    path === '/properties' ? Promise.resolve(props) : Promise.resolve([]));
};

describe('Properties pure helpers', () => {
  it('isDisposedProp / mortgageOf / equityOf', () => {
    expect(isDisposedProp(disposed)).toBe(true);
    expect(isDisposedProp(owned)).toBe(false);
    expect(mortgageOf(mortgaged)).toBe(150000);
    expect(mortgageOf(baseProp({ mortgage_account_id: null, mortgage_balance: 50000 }))).toBe(50000);
    expect(mortgageOf(baseProp({ mortgage_account_id: 1, mortgage_account_balance: null }))).toBe(0);
    expect(equityOf(mortgaged)).toBe(350000);
  });
  it('addressLine builds from parts', () => {
    expect(addressLine(owned)).toBe('123 Main St · Townsville, CA 90210');
    expect(addressLine(baseProp({ address: null, city: null, state: null, zip: null }))).toBe('');
  });
  it('appreciation helpers', () => {
    expect(appreciationOf(owned)).toBe(100000);
    expect(appreciationOf(baseProp({ current_value: null }))).toBeNull();
    expect(appreciationPctOf(owned)).toBeCloseTo(33.333, 1);
    expect(appreciationPctOf(baseProp({ purchase_price: 0 }))).toBeNull();
  });
  it('monthsOwnedOf / monthlyCostOf', () => {
    expect(monthsOwnedOf(owned)).toBeGreaterThan(0);
    expect(monthsOwnedOf(baseProp({ purchase_date: null }))).toBeNull();
    expect(monthlyCostOf(owned)).toBeGreaterThan(0);
    expect(monthlyCostOf(baseProp({ purchase_date: null }))).toBeNull();
  });
  it('daysSince / warningsOf / propertyDocTypeLabel', () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince('2000-01-01')).toBeGreaterThan(0);
    expect(warningsOf(baseProp({ current_value: null, purchase_price: null }))).toEqual(
      expect.arrayContaining(['Needs current value', 'Missing purchase price']),
    );
    expect(warningsOf(vacantRental)).toEqual(expect.arrayContaining(['Vacant rental', 'Lease has ended']));
    expect(warningsOf(baseProp({ is_rental: true, is_occupied: true, tenant_name: null }))).toContain('Occupied, no tenant on file');
    expect(propertyDocTypeLabel('deed')).toBe('Deed / Title');
    expect(propertyDocTypeLabel('nope')).toBe('Other');
  });
});

describe('Properties page', () => {
  beforeEach(() => {
    navMock.mockReset();
    localStorage.clear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows the empty state when there are no properties', async () => {
    setFixtures([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No properties yet/)).toBeInTheDocument());
  });

  it('shows an error when the request fails', async () => {
    (api.get as any).mockImplementation((path: string) =>
      path === '/properties' ? Promise.reject(new Error('boom')) : Promise.resolve([]));
    renderPage();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('renders property cards, warnings, and summary/charts', async () => {
    setFixtures([owned, rental, mortgaged, vacantRental]);
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    expect(cardTitle('Rental Unit')).toBeInTheDocument();
    expect(cardTitle('Mortgaged Home')).toBeInTheDocument();
    // Rental occupancy tag + notes + warnings.
    expect(screen.getByText(/Rental · Occupied/)).toBeInTheDocument();
    expect(screen.getByText('nice place')).toBeInTheDocument();
    expect(screen.getAllByText(/Needs attention/).length).toBeGreaterThan(0);
    // Charts: multiple values -> pie + equity bars, and missing-value note.
    expect(screen.getByText('Value by Property')).toBeInTheDocument();
    expect(screen.getByText('Equity vs Mortgage by Property')).toBeInTheDocument();
    expect(screen.getByText(/missing a current value/)).toBeInTheDocument();
    // Summary stat cards.
    expect(screen.getByText('Total Value')).toBeInTheDocument();
    expect(screen.getByText('Monthly Rental Income')).toBeInTheDocument();
  });

  it('shows mortgage-data-incomplete warning', async () => {
    setFixtures([baseProp({ id: 7, name: 'Incomplete', mortgage_account_id: 3, mortgage_account_balance: null })]);
    renderPage();
    await waitFor(() => expect(cardTitle('Incomplete')).toBeInTheDocument());
    expect(screen.getByText('Mortgage data incomplete')).toBeInTheDocument();
  });

  it('renders the single-value chart branch', async () => {
    setFixtures([owned]);
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    // Only one property with a value -> the single-bar layout (name appears in chart card too).
    expect(screen.getByText('Value by Property')).toBeInTheDocument();
  });

  it('toggles charts off and on', async () => {
    const user = userEvent.setup();
    setFixtures([owned, rental]);
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    await user.click(screen.getByText('Hide Charts'));
    expect(screen.queryByText('Value by Property')).not.toBeInTheDocument();
    await user.click(screen.getByText('Show Charts'));
    expect(screen.getByText('Value by Property')).toBeInTheDocument();
  });

  it('walks every filter option', async () => {
    const user = userEvent.setup();
    setFixtures([owned, rental, mortgaged, vacantRental, disposed]);
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    const select = screen.getByRole('combobox');
    for (const val of ['all', 'previous', 'rental', 'mortgaged', 'outright', 'missing', 'missing_value', 'owned']) {
      await user.selectOptions(select, val);
    }
    // 'previous' path shows disposed card; go back there to assert.
    await user.selectOptions(select, 'previous');
    expect(cardTitle('Sold Home')).toBeInTheDocument();
  });

  it('shows a no-match empty state for a filter', async () => {
    const user = userEvent.setup();
    setFixtures([owned]); // owned, not a rental
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox'), 'rental');
    expect(screen.getByText('No properties match this filter.')).toBeInTheDocument();
  });

  it('toggles the Previously Owned section', async () => {
    const user = userEvent.setup();
    setFixtures([owned, disposed]);
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    expect(screen.getByText(/Previously Owned Properties · 1/)).toBeInTheDocument();
    // Collapsed by default -> Show reveals the disposed card.
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(cardTitle('Sold Home')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
  });

  it('navigates when opening a property and adding one', async () => {
    const user = userEvent.setup();
    setFixtures([owned]);
    renderPage();
    await waitFor(() => expect(cardTitle('Owned Home')).toBeInTheDocument());
    // Click the card itself.
    await user.click(cardTitle('Owned Home'));
    expect(navMock).toHaveBeenCalledWith('/properties/1');
    // Add Property head button.
    await user.click(screen.getByRole('button', { name: 'Add Property' }));
    expect(navMock).toHaveBeenCalledWith('/properties/new');
  });

  it('renders the disposed card gain/loss and its View Details button', async () => {
    const user = userEvent.setup();
    setFixtures([disposed]);
    renderPage();
    // With no owned properties the summary/list is empty; expand Previously Owned.
    await waitFor(() => expect(screen.getByText(/Previously Owned Properties · 1/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(cardTitle('Sold Home')).toBeInTheDocument();
    // sale 420000 vs paid 300000 -> net gain.
    expect(screen.getByText(/Net gain vs paid/)).toBeInTheDocument();
    const card = cardTitle('Sold Home').closest('.card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /View Details/ }));
    expect(navMock).toHaveBeenCalledWith('/properties/5');
  });
});
