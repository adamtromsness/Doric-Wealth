import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  SubscriptionSuggestions, SubscriptionSuggestionDetail, SubscriptionAlert, justification,
  type SubscriptionSuggestion,
} from './SubscriptionSuggestions';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const mkSuggestion = (over: Partial<SubscriptionSuggestion> = {}): SubscriptionSuggestion => ({
  merchant: 'ACME Media',
  key: 'acme-9.99-monthly',
  amount: 9.99,
  billing_cycle: 'monthly',
  count: 6,
  last_date: '2026-08-01',
  next_due_date: '2026-09-01',
  interval_days: 30,
  transactions: [
    { id: 101, date: '2026-07-01', amount: 9.99, merchant: 'ACME MEDIA LLC' },
    { id: 102, date: '2026-08-01', amount: 9.99, merchant: 'ACME MEDIA LLC' },
  ],
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('justification helper', () => {
  it('describes yearly / quarterly / monthly / weekly / raw cadences', () => {
    expect(justification(mkSuggestion({ interval_days: 365 }))).toContain('about once a year');
    expect(justification(mkSuggestion({ interval_days: 90 }))).toContain('about once a quarter');
    expect(justification(mkSuggestion({ interval_days: 30 }))).toContain('about once a month');
    expect(justification(mkSuggestion({ interval_days: 7 }))).toContain('about once a week');
    expect(justification(mkSuggestion({ interval_days: 3 }))).toContain('about every 3 days');
  });
});

describe('SubscriptionSuggestions modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
  });

  it('shows a loading, then a populated list', async () => {
    let resolve!: (v: SubscriptionSuggestion[]) => void;
    (api.get as any).mockImplementation(() => new Promise<SubscriptionSuggestion[]>((r) => { resolve = r; }));
    wrap(<SubscriptionSuggestions onClose={vi.fn()} />);
    expect(screen.getByText('Scanning your transactions…')).toBeInTheDocument();
    resolve([mkSuggestion()]);
    await waitFor(() => expect(screen.getByText('ACME Media')).toBeInTheDocument());
  });

  it('shows an empty state when no suggestions', async () => {
    (api.get as any).mockResolvedValue([]);
    wrap(<SubscriptionSuggestions onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No likely subscriptions found in your transactions.')).toBeInTheDocument());
  });

  it('confirms a row, calls onChanged, and closes when the list empties', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion()]);
    const onClose = vi.fn(), onChanged = vi.fn();
    wrap(<SubscriptionSuggestions onClose={onClose} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText('ACME Media')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Confirm'));
    expect(api.post).toHaveBeenCalledWith('/subscriptions/suggestions/confirm', expect.objectContaining({ merchant: 'ACME Media', subscription_id: null }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores a row', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion()]);
    const onClose = vi.fn();
    wrap(<SubscriptionSuggestions onClose={onClose} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('ACME Media')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Ignore'));
    expect(api.post).toHaveBeenCalledWith('/subscriptions/suggestions/ignore', { merchant: 'ACME Media' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps other rows when the list has more than one', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion(), mkSuggestion({ merchant: 'Other Co', key: 'other' })]);
    const onClose = vi.fn();
    wrap(<SubscriptionSuggestions onClose={onClose} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Other Co')).toBeInTheDocument());
    await userEvent.click(screen.getAllByText('Confirm')[0]);
    await waitFor(() => expect(screen.queryByText('ACME Media')).toBeNull());
    expect(screen.getByText('Other Co')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces an error when confirm fails', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion()]);
    (api.post as any).mockRejectedValue(new Error('confirm boom'));
    wrap(<SubscriptionSuggestions onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('ACME Media')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByText('confirm boom')).toBeInTheDocument());
  });

  it('surfaces an error when the initial load fails', async () => {
    (api.get as any).mockRejectedValue(new Error('load boom'));
    wrap(<SubscriptionSuggestions onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('load boom')).toBeInTheDocument());
  });

  it('opens the per-row detail when a row is clicked, and Close button closes', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion()]);
    const onClose = vi.fn();
    wrap(<SubscriptionSuggestions onClose={onClose} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('ACME Media')).toBeInTheDocument());
    // Clicking the merchant cell opens the detail modal (heading is an h3 of the merchant).
    await userEvent.click(screen.getByText('ACME Media'));
    await waitFor(() => expect(screen.getByText('Possible Subscription')).toBeInTheDocument());
    // Close the detail modal via its own Close button (first in DOM order).
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(screen.queryByText('Possible Subscription')).toBeNull());
    // Now close the main modal.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SubscriptionSuggestionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
  });

  it('renders justification and charges, then confirms as a NEW subscription', async () => {
    (api.get as any).mockResolvedValue([]); // no existing subs
    const onClose = vi.fn(), onChanged = vi.fn();
    wrap(<SubscriptionSuggestionDetail suggestion={mkSuggestion()} onClose={onClose} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/Charged 6 times/)).toBeInTheDocument());
    expect(screen.getAllByText('ACME MEDIA LLC').length).toBe(2);
    await userEvent.click(screen.getByText('Confirm subscription'));
    expect(api.post).toHaveBeenCalledWith('/subscriptions/suggestions/confirm', expect.objectContaining({ subscription_id: null }));
    await waitFor(() => { expect(onChanged).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled(); });
  });

  it('adds to an EXISTING subscription after picking one', async () => {
    (api.get as any).mockResolvedValue([{ id: 7, name: 'Existing Sub' }]);
    const onClose = vi.fn(), onChanged = vi.fn();
    wrap(<SubscriptionSuggestionDetail suggestion={mkSuggestion()} onClose={onClose} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/existing subscription/)).toBeInTheDocument());
    // Toggle to existing mode.
    await userEvent.click(screen.getByText(/existing subscription/));
    // Confirm without a pick -> validation error.
    await userEvent.click(screen.getByText('Add to subscription'));
    expect(screen.getByText('Pick a subscription to add these charges to.')).toBeInTheDocument();
    // Now pick and confirm.
    await userEvent.selectOptions(screen.getByRole('combobox'), '7');
    await userEvent.click(screen.getByText('Add to subscription'));
    expect(api.post).toHaveBeenCalledWith('/subscriptions/suggestions/confirm', expect.objectContaining({ subscription_id: 7 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('ignores the candidate', async () => {
    (api.get as any).mockResolvedValue([]);
    const onClose = vi.fn(), onChanged = vi.fn();
    wrap(<SubscriptionSuggestionDetail suggestion={mkSuggestion()} onClose={onClose} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/Charged 6 times/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/Ignore — it's not a subscription/));
    expect(api.post).toHaveBeenCalledWith('/subscriptions/suggestions/ignore', { merchant: 'ACME Media' });
    await waitFor(() => { expect(onChanged).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled(); });
  });

  it('surfaces an error when confirm fails', async () => {
    (api.get as any).mockResolvedValue([]);
    (api.post as any).mockRejectedValue(new Error('detail boom'));
    wrap(<SubscriptionSuggestionDetail suggestion={mkSuggestion()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Charged 6 times/)).toBeInTheDocument());
    await userEvent.click(screen.getByText('Confirm subscription'));
    await waitFor(() => expect(screen.getByText('detail boom')).toBeInTheDocument());
  });

  it('surfaces an error when ignore fails', async () => {
    (api.get as any).mockResolvedValue([]);
    (api.post as any).mockRejectedValue(new Error('ignore boom'));
    wrap(<SubscriptionSuggestionDetail suggestion={mkSuggestion()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Charged 6 times/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/Ignore — it's not a subscription/));
    await waitFor(() => expect(screen.getByText('ignore boom')).toBeInTheDocument());
  });
});

describe('SubscriptionAlert', () => {
  beforeEach(() => { vi.clearAllMocks(); (api.post as any).mockResolvedValue({}); });

  it('shows the banner off the subscriptions page, opens the review, and dismisses', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion(), mkSuggestion({ merchant: 'B', key: 'b' })]);
    render(<MemoryRouter initialEntries={['/dashboard']}><SubscriptionAlert /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/potential subscriptions/)).toBeInTheDocument());
    // Review opens the modal.
    await userEvent.click(screen.getByText('Review'));
    await waitFor(() => expect(screen.getByText('Possible Subscriptions')).toBeInTheDocument());
  });

  it('opens by clicking the banner body and via keyboard, then dismisses with ✕', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion()]);
    render(<MemoryRouter initialEntries={['/dashboard']}><SubscriptionAlert /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /potential subscription/ })).toBeInTheDocument());
    const banner = screen.getByRole('button', { name: /potential subscription/ });
    banner.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('Possible Subscriptions')).toBeInTheDocument());
    // Close the modal, then dismiss the banner.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByText(/potential subscription/)).toBeNull());
  });

  it('hides the banner on the subscriptions page', async () => {
    (api.get as any).mockResolvedValue([mkSuggestion()]);
    render(<MemoryRouter initialEntries={['/subscriptions']}><SubscriptionAlert /></MemoryRouter>);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText(/potential subscription/)).toBeNull();
  });
});
