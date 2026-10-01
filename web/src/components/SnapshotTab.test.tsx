import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SnapshotTab } from './SnapshotTab';
import type { SnapItem } from './SnapshotSection';

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const items = (n: number): SnapItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, as_of: `2026-0${(i % 9) + 1}-10`, value: 100 + i }));

describe('SnapshotTab', () => {
  it('renders title, chart (>=2 items), and list', () => {
    const { container } = wrap(<SnapshotTab items={items(2)} onAdd={vi.fn()} onDelete={vi.fn()} title="Value Snapshots" chartTitle="Value Over Time" />);
    expect(screen.getByText('Value Snapshots')).toBeInTheDocument();
    expect(screen.getByText('Value Over Time')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('omits the chart card with fewer than 2 items', () => {
    wrap(<SnapshotTab items={items(1)} onAdd={vi.fn()} onDelete={vi.fn()} chartTitle="Value Over Time" />);
    expect(screen.queryByText('Value Over Time')).toBeNull();
  });

  it('shows a hint when provided', () => {
    wrap(<SnapshotTab items={[]} onAdd={vi.fn()} onDelete={vi.fn()} hint="record it" />);
    expect(screen.getByText('record it')).toBeInTheDocument();
  });

  it('shows emptyText only when there are no items', () => {
    const { rerender } = wrap(<SnapshotTab items={[]} onAdd={vi.fn()} onDelete={vi.fn()} emptyText="nothing yet" />);
    expect(screen.getByText('nothing yet')).toBeInTheDocument();
    rerender(<MemoryRouter><SnapshotTab items={items(1)} onAdd={vi.fn()} onDelete={vi.fn()} emptyText="nothing yet" /></MemoryRouter>);
    expect(screen.queryByText('nothing yet')).toBeNull();
  });

  it('renders an estimate button and message and fires onEstimate', async () => {
    const user = userEvent.setup();
    const onEstimate = vi.fn();
    wrap(<SnapshotTab items={[]} onAdd={vi.fn()} onDelete={vi.fn()} onEstimate={onEstimate} estimateLabel="Estimate & Record" estimateMsg="did it" />);
    expect(screen.getByText('did it')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Estimate & Record' }));
    expect(onEstimate).toHaveBeenCalled();
  });

  it('shows an estimating state and disables the button', () => {
    wrap(<SnapshotTab items={[]} onAdd={vi.fn()} onDelete={vi.fn()} onEstimate={vi.fn()} estimating />);
    expect(screen.getByRole('button', { name: 'Estimating…' })).toBeDisabled();
  });

  it('disables the estimate button and shows the reason when estimateDisabledReason is set', () => {
    wrap(<SnapshotTab items={[]} onAdd={vi.fn()} onDelete={vi.fn()} onEstimate={vi.fn()} estimateDisabledReason="no key" />);
    expect(screen.getByRole('button', { name: 'Estimate & Record' })).toBeDisabled();
    expect(screen.getByText('no key')).toBeInTheDocument();
  });

  it('uses explicit chartPoints for the chart when provided', () => {
    const points = [{ as_of: '2026-01-01', value: 1 }, { as_of: '2026-02-01', value: 2 }];
    wrap(<SnapshotTab items={[]} onAdd={vi.fn()} onDelete={vi.fn()} chartPoints={points} chartTitle="Over Time" />);
    expect(screen.getByText('Over Time')).toBeInTheDocument();
  });

  it('wires onAdd through the embedded add row', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    wrap(<SnapshotTab items={[]} onAdd={onAdd} onDelete={vi.fn()} addLabel="Record Value" placeholder="0.00" />);
    await user.type(screen.getByPlaceholderText('0.00'), '55');
    await user.click(screen.getByRole('button', { name: 'Record Value' }));
    expect(onAdd.mock.calls.length).toBeGreaterThan(0);
  });
});
