import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TxnEditor } from './TxnEditor';
import type { Lookups, Txn } from './helpers';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { get: vi.fn().mockResolvedValue({}), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

const lookups: Lookups = {
  categories: [], accounts: [{ id: 1, name: 'Checking', type: 'checking' } as any],
  vehicles: [], properties: [], subscriptions: [], tags: [],
};

const renderEditor = (props: Partial<Parameters<typeof TxnEditor>[0]> = {}) =>
  render(
    <TxnEditor txn={null} lookups={lookups} purchasers={[]} merchants={[]} onClose={vi.fn()} onSaved={vi.fn()} {...props} />,
  );

// The Amount input is the one with the 0.00 placeholder in the primary row.
const amountInput = () => screen.getAllByPlaceholderText('0.00')[0];

describe('TxnEditor focus', () => {
  it('Add Transaction starts with the cursor in Amount, so typing enters the amount', async () => {
    renderEditor();
    expect(screen.getByText('Add Transaction')).toBeInTheDocument();
    expect(amountInput()).toHaveFocus();
    await userEvent.keyboard('42.50');
    expect(amountInput()).toHaveValue('42.50');
  });

  it('does not move the cursor when editing an existing transaction', () => {
    const txn = {
      id: 7, account_id: 1, amount: 12.34, direction: 'expense', txn_date: '2026-09-01', posted_date: '2026-09-02',
      tags: [], splits: [], has_splits: false, has_receipt: false,
    } as unknown as Txn;
    renderEditor({ txn });
    expect(screen.getByText('Edit Transaction')).toBeInTheDocument();
    expect(amountInput()).not.toHaveFocus();
  });

  it('does not move the cursor when reviewing an imported row', () => {
    renderEditor({ seed: { amount: 9.99 } as any, confirmStaged: { id: 3, source: 'csv', external_id: null } });
    expect(screen.getByText('Review & Add Transaction')).toBeInTheDocument();
    expect(amountInput()).not.toHaveFocus();
  });
});
