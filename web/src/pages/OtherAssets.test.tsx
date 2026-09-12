import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import OtherAssets from './OtherAssets';

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

const asset = {
  id: 7, name: 'Airstream', asset_type: 'rv', value: 30000, purchase_price: 25000,
  purchase_date: '2020-01-15', notes: 'road trips', tracks_value: true,
  has_maintenance: true, has_insurance: false, has_documents: false,
};

const renderPage = () => render(<MemoryRouter><OtherAssets /></MemoryRouter>);

describe('OtherAssets page', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    (api.get as any).mockResolvedValue([asset]);
    (api.post as any).mockResolvedValue({ id: 99 });
  });

  it('renders the asset list with gain and track tags', async () => {
    renderPage();
    expect(await screen.findByText('Airstream')).toBeInTheDocument();
    expect(screen.getByText('$30,000.00')).toBeInTheDocument();
    // gain = 30000 - 25000 = 5000
    expect(screen.getByText('$5,000.00')).toBeInTheDocument();
    // Track tags for the enabled capabilities.
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('Tracks:')).toBeInTheDocument();
  });

  it('shows the empty state when there are no assets', async () => {
    (api.get as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No other assets yet/)).toBeInTheDocument();
  });

  it('shows an error when the load fails', async () => {
    (api.get as any).mockRejectedValue(new Error('load failed'));
    renderPage();
    expect(await screen.findByText('load failed')).toBeInTheDocument();
  });

  it('navigates to the detail page from the card and the View Details button', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Airstream');
    await user.click(screen.getByRole('button', { name: /View Details/ }));
    expect(navigateMock).toHaveBeenCalledWith('/other-assets/7');
    navigateMock.mockClear();
    await user.click(screen.getByTitle('View asset details'));
    expect(navigateMock).toHaveBeenCalledWith('/other-assets/7');
  });

  it('opens the add modal, validates a missing name, then creates and navigates', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No other assets yet/);
    await user.click(screen.getByRole('button', { name: 'Add Asset' }));
    const modal = () => within(document.querySelector('.modal') as HTMLElement);
    // Save stays disabled until the form is dirty, so a whitespace-only name is
    // what actually reaches the validation branch.
    const nameInput = screen.getByPlaceholderText('e.g. Lake cabin boat');
    await user.type(nameInput, '   ');
    await user.click(modal().getByRole('button', { name: 'Add Asset' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.clear(nameInput);
    await user.type(nameInput, 'New Boat');
    await user.click(modal().getByRole('button', { name: 'Add Asset' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/assets', expect.objectContaining({ name: 'New Boat', asset_type: 'other' })));
    expect(navigateMock).toHaveBeenCalledWith('/other-assets/99');
  });

  it('surfaces a save error from the editor', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    (api.post as any).mockRejectedValue(new Error('save boom'));
    renderPage();
    await screen.findByText(/No other assets yet/);
    await user.click(screen.getByRole('button', { name: 'Add Asset' }));
    await user.type(screen.getByPlaceholderText('e.g. Lake cabin boat'), 'X');
    await user.click(within(document.querySelector('.modal') as HTMLElement).getByRole('button', { name: 'Add Asset' }));
    expect(await screen.findByText('save boom')).toBeInTheDocument();
  });

  it('closes the add modal without saving', async () => {
    const user = userEvent.setup();
    (api.get as any).mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No other assets yet/);
    await user.click(screen.getByRole('button', { name: 'Add Asset' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('e.g. Lake cabin boat')).toBeNull());
  });

  it('renders a purchase-date subtitle when there are no notes', async () => {
    (api.get as any).mockResolvedValue([{ ...asset, notes: null, tracks_value: false, has_maintenance: false }]);
    renderPage();
    expect(await screen.findByText(/Purchased/)).toBeInTheDocument();
  });
});
