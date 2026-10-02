import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PropertyAutoValue } from './PropertyAutoValue';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from '../api';

const prop = (over: Partial<any> = {}) => ({ id: 9, name: 'Home', auto_value_enabled: false, auto_value_frequency: 'monthly', auto_value_last_success_at: null, auto_value_last_error: null, ...over }) as any;
const rc = (configured: boolean) => (api.get as any).mockResolvedValue({ configured, book_key_set: configured, key_hint: null, server_fallback: false, can_manage: true });
const renderCard = (p: any, onChanged = vi.fn()) => { render(<MemoryRouter><PropertyAutoValue property={p} onChanged={onChanged} /></MemoryRouter>); return onChanged; };

describe('PropertyAutoValue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('without a RentCast key: disabled, with a link to the integration', async () => {
    rc(false);
    renderCard(prop());
    expect(await screen.findByRole('link', { name: 'Integrations → RentCast' })).toHaveAttribute('href', '/integrations/rentcast');
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('turns it on (monthly by default) and changes the frequency', async () => {
    const user = userEvent.setup();
    rc(true);
    (api.put as any).mockResolvedValue({});
    const onChanged = renderCard(prop());
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled());
    await user.click(screen.getByRole('checkbox'));
    expect(api.put).toHaveBeenCalledWith('/properties/9/auto-value', { enabled: true, frequency: 'monthly' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('when on: shows the frequency, last update, and a recorded error', async () => {
    const user = userEvent.setup();
    rc(true);
    (api.put as any).mockResolvedValue({});
    renderCard(prop({ auto_value_enabled: true, auto_value_last_success_at: '2026-09-01T12:00:00Z', auto_value_last_error: 'RentCast rejected the API key.' }));
    expect(await screen.findByText(/Last updated Sep 1, 2026 from RentCast/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't update automatically: RentCast rejected the API key/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Update Frequency' }), 'weekly');
    expect(api.put).toHaveBeenCalledWith('/properties/9/auto-value', { enabled: true, frequency: 'weekly' });
  });

  it('shows the server refusal (e.g. no address)', async () => {
    const user = userEvent.setup();
    rc(true);
    (api.put as any).mockRejectedValue(new Error("Add the property's street address first."));
    renderCard(prop());
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled());
    await user.click(screen.getByRole('checkbox'));
    expect(await screen.findByText("Add the property's street address first.")).toBeInTheDocument();
  });
});
