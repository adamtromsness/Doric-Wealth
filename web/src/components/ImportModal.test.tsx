import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ImportModal, StagedEditor } from './ImportModal';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn() };
});
import { api } from '../api';

const accounts = [{ id: 1, name: 'Checking' }, { id: 2, name: 'Savings' }];

const preview = (over: Partial<any> = {}) => ({
  headers: ['Date', 'Amount', 'Merchant', 'Memo'],
  rowCount: 3,
  sampleRows: [['2026-01-01', '-10.00', 'Store', 'note'], ['2026-01-02', '20.00', 'Job', '']],
  suggestedMapping: { date: 0, amount: 1, merchant: 2, description: 3 },
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

// jsdom File.text() is available; but ensure it exists.
const csvFile = (content = 'Date,Amount\n2026-01-01,-10') =>
  new File([content], 'bank.csv', { type: 'text/csv' });

describe('ImportModal', () => {
  beforeEach(() => vi.clearAllMocks());

  const pickFile = async (user: ReturnType<typeof userEvent.setup>) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, csvFile());
  };

  it('renders the upload prompt initially', () => {
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    expect(screen.getByText('Import transactions from CSV')).toBeInTheDocument();
    expect(screen.getByText('Choose CSV file…')).toBeInTheDocument();
  });

  it('previews a chosen file and shows the mapping UI', async () => {
    (api.post as any).mockResolvedValueOnce(preview());
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText(/bank.csv/)).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/imports/preview', expect.objectContaining({ text: expect.any(String) }));
    expect(screen.getByText('Import 3 rows')).toBeInTheDocument();
    // Account auto-selected to first account.
    expect(screen.getByText('Store')).toBeInTheDocument();
  });

  it('surfaces a preview error', async () => {
    (api.post as any).mockRejectedValueOnce(new Error('parse boom'));
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText('parse boom')).toBeInTheDocument());
  });

  it('imports and shows a success summary, then calls onImported', async () => {
    (api.post as any)
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ total: 3, duplicates: 1, imported: 2, invalid: 0 });
    const onImported = vi.fn();
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={onImported} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText('Import 3 rows')).toBeInTheDocument());
    await user.click(screen.getByText('Import 3 rows'));
    await waitFor(() => expect(screen.getByText(/View 2 in review queue/)).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/imports', expect.objectContaining({ account_id: 1 }));
    await user.click(screen.getByText(/View 2 in review queue/));
    expect(onImported).toHaveBeenCalled();
  });

  it('shows the nothing-imported branch and can go back to mapping', async () => {
    (api.post as any)
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ total: 3, duplicates: 1, imported: 0, invalid: 2 });
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText('Import 3 rows')).toBeInTheDocument());
    await user.click(screen.getByText('Import 3 rows'));
    await waitFor(() => expect(screen.getByText(/No transactions could be imported/)).toBeInTheDocument());
    await user.click(screen.getByText('Back to Mapping'));
    await waitFor(() => expect(screen.getByText('Import 3 rows')).toBeInTheDocument());
  });

  it('surfaces an import error', async () => {
    (api.post as any)
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new Error('import boom'));
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText('Import 3 rows')).toBeInTheDocument());
    await user.click(screen.getByText('Import 3 rows'));
    await waitFor(() => expect(screen.getByText('import boom')).toBeInTheDocument());
  });

  it('toggles the split debit/credit mapping', async () => {
    (api.post as any).mockResolvedValueOnce(preview({
      suggestedMapping: { date: 0, debit: 1, credit: 2, merchant: 3 },
    }));
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    // split auto-detected because amount is null with debit/credit present
    await waitFor(() => expect(screen.getByText(/separate debit/)).toBeInTheDocument());
    expect(screen.getByText('Debit (Money Out) Column')).toBeInTheDocument();
    // Toggle it off to reveal the single amount mapping.
    await user.click(screen.getByRole('checkbox', { name: /separate debit/ }));
    await waitFor(() => expect(screen.getByText('Amount Column')).toBeInTheDocument());
  });

  it('goes back from the mapping view to the upload prompt', async () => {
    (api.post as any).mockResolvedValueOnce(preview());
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText('Back')).toBeInTheDocument());
    await user.click(screen.getByText('Back'));
    await waitFor(() => expect(screen.getByText('Choose CSV file…')).toBeInTheDocument());
  });

  it('validates a missing account before import', async () => {
    (api.post as any).mockResolvedValueOnce(preview());
    const user = userEvent.setup();
    // No accounts -> accountId starts empty.
    wrap(<ImportModal accounts={[]} onClose={() => {}} onImported={() => {}} />);
    await pickFile(user);
    await waitFor(() => expect(screen.getByText('Import 3 rows')).toBeInTheDocument());
    // Import button is disabled with no account, so call doImport via the enabled path
    // is impossible; assert the button is disabled instead.
    expect(screen.getByText('Import 3 rows')).toBeDisabled();
  });

  it('closes on scrim click', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<ImportModal accounts={accounts} onClose={onClose} onImported={() => {}} />);
    await user.click(document.querySelector('.scrim')!);
    expect(onClose).toHaveBeenCalled();
  });
});

const staged = (over: Partial<any> = {}): any => ({
  id: 10, account_id: 1, category_id: null, txn_date: '2026-01-01', amount: 12.5,
  direction: 'expense', merchant: 'Store', description: 'note', decision: 'import',
  raw_merchant: 'RAW STORE', skip_reason: null, duplicate_of: null,
  dup_merchant: null, dup_amount: null, dup_date: null, ...over,
});

const categories = [
  { id: 100, name: 'Expenses', parent_id: null, has_children: true, kind: 'expense', sort_order: 0 },
  { id: 101, name: 'Groceries', parent_id: 100, has_children: false, kind: 'expense', sort_order: 0 },
];

describe('StagedEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves an edited row', async () => {
    (api.put as any).mockResolvedValue({});
    const onSaved = vi.fn();
    const user = userEvent.setup();
    wrap(<StagedEditor staged={staged()} accounts={accounts} categories={categories as any} merchants={['Store']} onClose={() => {}} onSaved={onSaved} />);
    expect(screen.getByText(/From file:/)).toBeInTheDocument();
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.put).toHaveBeenCalledWith('/imports/staged/10', expect.objectContaining({ decision: 'import' }));
  });

  it('saves and confirms (posts) a row', async () => {
    (api.put as any).mockResolvedValue({});
    (api.post as any).mockResolvedValue({});
    const onSaved = vi.fn();
    const user = userEvent.setup();
    wrap(<StagedEditor staged={staged()} accounts={accounts} categories={categories as any} merchants={[]} onClose={() => {}} onSaved={onSaved} />);
    await user.click(screen.getByText('Confirm & Post'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/imports/staged/10/confirm'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the matches-existing skip notice and Add Anyway', async () => {
    const user = userEvent.setup();
    (api.put as any).mockRejectedValue(new Error('save fail'));
    wrap(<StagedEditor staged={staged({ decision: 'skip', duplicate_of: 5, dup_merchant: 'Shop', dup_amount: 9, dup_date: '2026-01-01' })}
      accounts={accounts} categories={categories as any} merchants={[]} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/Skipped on import/)).toBeInTheDocument();
    expect(screen.getByText('Add Anyway')).toBeInTheDocument();
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByText('save fail')).toBeInTheDocument());
  });

  it('shows the duplicate-in-file skip notice', () => {
    wrap(<StagedEditor staged={staged({ decision: 'skip', skip_reason: 'duplicate_in_file' })}
      accounts={accounts} categories={categories as any} merchants={[]} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/appear more than once/)).toBeInTheDocument();
  });

  it('cancels via the Cancel button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<StagedEditor staged={staged()} accounts={accounts} categories={categories as any} merchants={[]} onClose={onClose} onSaved={() => {}} />);
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('errors when confirm posting fails', async () => {
    (api.put as any).mockResolvedValue({});
    (api.post as any).mockRejectedValue(new Error('post fail'));
    const user = userEvent.setup();
    wrap(<StagedEditor staged={staged()} accounts={accounts} categories={categories as any} merchants={[]} onClose={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByText('Confirm & Post'));
    await waitFor(() => expect(screen.getByText('post fail')).toBeInTheDocument());
  });
});
