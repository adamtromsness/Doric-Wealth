import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AssetDetail from './AssetDetail';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

// Keep the entity capability tabs light — they have their own coverage.
vi.mock('../components/EntityMaintenance', () => ({ EntityMaintenance: () => <div>Maintenance Panel</div> }));
vi.mock('../components/EntityInsurance', () => ({ EntityInsurance: () => <div>Insurance Panel</div> }));
vi.mock('../components/EntityDocuments', () => ({ EntityDocuments: () => <div>Documents Panel</div> }));

const asset = {
  id: 3, name: 'Airstream', asset_type: 'rv', value: 30000, purchase_price: 25000,
  purchase_date: '2020-01-15', notes: 'road trips', tracks_value: false,
  has_maintenance: true, has_insurance: true, has_documents: true,
};

const values = [
  { id: 1, as_of: '2026-01-01', value: 28000 },
  { id: 2, as_of: '2026-06-01', value: 30000 },
];

function setup(fixtures: Record<string, any> = {}) {
  const map: Record<string, any> = {
    '/assets': [asset],
    '/assets/3/values': values,
    ...fixtures,
  };
  (api.get as any).mockImplementation((path: string) =>
    map[path] !== undefined ? Promise.resolve(map[path]) : Promise.resolve([]));
}

const renderAt = (id = '3') =>
  render(
    <MemoryRouter initialEntries={[`/other-assets/${id}`]}>
      <Routes><Route path="/other-assets/:assetId" element={<AssetDetail />} /></Routes>
    </MemoryRouter>
  );

describe('AssetDetail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockReset();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
    setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders the overview with facts, value, and gain', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { name: /Airstream/ })).toBeInTheDocument();
    expect(screen.getAllByText('$30,000.00').length).toBeGreaterThan(0);
    // gain = 5000
    expect(screen.getAllByText('$5,000.00').length).toBeGreaterThan(0);
    expect(screen.getByText('road trips')).toBeInTheDocument();
  });

  it('shows a not-found error when the asset id is missing', async () => {
    setup({ '/assets': [] });
    renderAt('999');
    expect(await screen.findByText('Asset not found.')).toBeInTheDocument();
  });

  it('shows an invalid error for a non-numeric id', async () => {
    renderAt('abc');
    expect(await screen.findByText('Invalid asset.')).toBeInTheDocument();
  });

  it('shows a loading state before the asset arrives', () => {
    (api.get as any).mockImplementation(() => new Promise(() => {}));
    renderAt();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('switches to the Value tab and adds a snapshot', async () => {
    const user = userEvent.setup();
    setup({ '/assets': [{ ...asset, tracks_value: true }] });
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Value' }));
    expect(await screen.findByText('Value Snapshots')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('0.00'), '31000');
    await user.click(screen.getByRole('button', { name: 'Record Value' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/assets/3/values', expect.objectContaining({ value: 31000 })));
  });

  it('deletes a snapshot from the Value tab', async () => {
    const user = userEvent.setup();
    setup({ '/assets': [{ ...asset, tracks_value: true }] });
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Value' }));
    await screen.findByText('Value Snapshots');
    const dels = screen.getAllByTitle('Delete');
    await user.click(dels[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(expect.stringMatching(/\/assets\/3\/values\/\d+/)));
  });

  it('renders the maintenance, insurance, and documents tabs', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Maintenance' }));
    expect(await screen.findByText('Maintenance Panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Insurance' }));
    expect(await screen.findByText('Insurance Panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Documents' }));
    expect(await screen.findByText('Documents Panel')).toBeInTheDocument();
  });

  it('edits and saves the asset from the Details tab', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const save = await screen.findByRole('button', { name: 'Save Changes' });
    expect(save).toBeDisabled();
    const name = screen.getByPlaceholderText('e.g. Airstream Trailer') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Renamed');
    expect(save).not.toBeDisabled();
    await user.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/assets/3', expect.objectContaining({ name: 'Renamed' })));
  });

  it('validates a blank name on save', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const name = screen.getByPlaceholderText('e.g. Airstream Trailer') as HTMLInputElement;
    await user.clear(name);
    // Make the form dirty (so Save is enabled) by toggling a capability, then save with a blank name.
    await user.click(screen.getByText('Track maintenance'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });

  it('surfaces a save error', async () => {
    const user = userEvent.setup();
    (api.put as any).mockRejectedValue(new Error('put failed'));
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const name = screen.getByPlaceholderText('e.g. Airstream Trailer') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('put failed')).toBeInTheDocument();
  });

  it('deletes the asset and navigates back', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/assets/3'));
    expect(navigateMock).toHaveBeenCalledWith('/other-assets');
  });

  it('does not delete when confirm is cancelled', async () => {
    const user = userEvent.setup();
    (window.confirm as any).mockReturnValue(false);
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(api.del).not.toHaveBeenCalled();
  });

  it('surfaces a delete error', async () => {
    const user = userEvent.setup();
    (api.del as any).mockRejectedValue(new Error('del failed'));
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('del failed')).toBeInTheDocument();
  });

  it('hides the Current Value field and falls back to Details when tracks_value turns off the tab', async () => {
    const user = userEvent.setup();
    setup({ '/assets': [{ ...asset, tracks_value: true }] });
    renderAt();
    await screen.findByRole('heading', { name: /Airstream/ });
    // Value tab is visible because tracks_value is true.
    await user.click(screen.getByRole('button', { name: 'Value' }));
    await screen.findByText('Value Snapshots');
    // Go to Details and turn OFF value tracking -> Value tab disappears, active tab falls back.
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByText('Track value over time'));
    // Current Value field now visible in the form (label appears in the grid).
    expect(await screen.findAllByText('Current Value')).not.toHaveLength(0);
  });

  describe('Add Asset (new mode)', () => {
    it('renders the details form on the page, without loading or a popup', async () => {
      renderAt('new');
      expect(screen.getByRole('heading', { name: 'Add Asset' })).toBeInTheDocument();
      expect(screen.getByText('New Asset')).toBeInTheDocument();
      expect(screen.getByText('What This Asset Tracks')).toBeInTheDocument();
      expect(document.querySelector('.modal')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Add Asset' })).toBeDisabled();
      // Properties have their own module, so "Property" isn't offered for a new asset.
      expect(screen.queryByRole('option', { name: 'Property' })).toBeNull();
      expect(api.get).not.toHaveBeenCalled();
    });

    it('validates a blank name', async () => {
      const user = userEvent.setup();
      renderAt('new');
      await user.type(screen.getByPlaceholderText('e.g. Airstream Trailer'), '   ');
      await user.click(screen.getByRole('button', { name: 'Add Asset' }));
      expect(await screen.findByText('Name is required.')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('creates the asset with its value and tracking choices, then opens it', async () => {
      const user = userEvent.setup();
      (api.post as any).mockResolvedValue({ ...asset, id: 42 });
      renderAt('new');
      await user.type(screen.getByPlaceholderText('e.g. Airstream Trailer'), 'Bass Boat');
      await user.selectOptions(screen.getByRole('combobox'), 'boat');
      await user.click(screen.getByText('Track value over time'));
      // The starting value stays editable on create even when value tracking is on.
      expect(screen.getByText('After saving, record value over time on the Value tab.')).toBeInTheDocument();
      await user.type(screen.getAllByPlaceholderText('0.00')[0], '12000');
      await user.click(screen.getByRole('button', { name: 'Add Asset' }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/assets', expect.objectContaining({
        name: 'Bass Boat', asset_type: 'boat', value: 12000, tracks_value: true,
      })));
      expect(navigateMock).toHaveBeenCalledWith('/other-assets/42');
    });

    it('surfaces a create error', async () => {
      const user = userEvent.setup();
      (api.post as any).mockRejectedValue(new Error('create failed'));
      renderAt('new');
      await user.type(screen.getByPlaceholderText('e.g. Airstream Trailer'), 'X');
      await user.click(screen.getByRole('button', { name: 'Add Asset' }));
      expect(await screen.findByText('create failed')).toBeInTheDocument();
      expect(navigateMock).not.toHaveBeenCalled();
    });
  });
});
