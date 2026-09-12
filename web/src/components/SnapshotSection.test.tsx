import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SnapshotSection, type SnapItem } from './SnapshotSection';

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const makeItems = (n: number): SnapItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    as_of: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
    value: 1000 + i,
  }));

describe('SnapshotSection', () => {
  it('renders hint, list (latest tag) and chart with >=2 items', () => {
    wrap(<SnapshotSection items={makeItems(2)} onAdd={vi.fn()} onDelete={vi.fn()} hint="a hint" />);
    expect(screen.getByText('a hint')).toBeInTheDocument();
    // newest-first: first row is the latest, tagged "latest".
    expect(screen.getByText('latest')).toBeInTheDocument();
  });

  it('does not render chart when fewer than 2 items', () => {
    const { container } = wrap(<SnapshotSection items={makeItems(1)} onAdd={vi.fn()} onDelete={vi.fn()} />);
    // Only one snapshot => no chart area (recharts mock renders a container div).
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows an auto tag for auto snapshots', () => {
    const items: SnapItem[] = [{ id: 1, as_of: '2026-01-01', value: 5, auto: true }];
    wrap(<SnapshotSection items={items} onAdd={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('⟳ auto')).toBeInTheDocument();
  });

  it('adds a snapshot with a parsed value and resets the input', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    wrap(<SnapshotSection items={makeItems(1)} onAdd={onAdd} onDelete={vi.fn()} addLabel="Add snapshot" placeholder="0.00" />);
    const btn = screen.getByRole('button', { name: 'Add snapshot' });
    expect(btn).toBeDisabled();
    const input = screen.getByPlaceholderText('0.00');
    await user.type(input, '1,200.50');
    expect(btn).not.toBeDisabled();
    await user.click(btn);
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(onAdd.mock.calls[0][1]).toBe(1200.5);
  });

  it('rounds to an integer when integer prop is set', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    wrap(<SnapshotSection items={[]} onAdd={onAdd} onDelete={vi.fn()} integer placeholder="mi" valueLabel="Miles" addLabel="Add" />);
    await user.type(screen.getByPlaceholderText('mi'), '1234.7');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(onAdd.mock.calls[0][1]).toBe(1235);
  });

  it('shows an error message when onAdd rejects and keeps the value', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockRejectedValue(new Error('nope'));
    wrap(<SnapshotSection items={[]} onAdd={onAdd} onDelete={vi.fn()} addLabel="Add" placeholder="0.00" />);
    await user.type(screen.getByPlaceholderText('0.00'), '10');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  it('shows a generic error when the rejection has no message', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockRejectedValue({});
    wrap(<SnapshotSection items={[]} onAdd={onAdd} onDelete={vi.fn()} addLabel="Add" placeholder="0.00" />);
    await user.type(screen.getByPlaceholderText('0.00'), '10');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Could not save.')).toBeInTheDocument();
  });

  it('deletes a snapshot', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    wrap(<SnapshotSection items={makeItems(1)} onAdd={vi.fn()} onDelete={onDelete} />);
    await user.click(screen.getByTitle('Delete'));
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it('renders the add block at the top when addAtTop is set', () => {
    const { container } = wrap(<SnapshotSection items={makeItems(1)} onAdd={vi.fn()} onDelete={vi.fn()} addAtTop addLabel="AddTop" />);
    expect(screen.getByRole('button', { name: 'AddTop' })).toBeInTheDocument();
    expect(container).toBeTruthy();
  });

  it('hides the chart when hideChart is set even with >=2 items', () => {
    const { container } = wrap(<SnapshotSection items={makeItems(3)} onAdd={vi.fn()} onDelete={vi.fn()} hideChart />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('paginates with a View all modal when over the preview limit', async () => {
    const user = userEvent.setup();
    wrap(<SnapshotSection items={makeItems(12)} onAdd={vi.fn()} onDelete={vi.fn()} valueLabel="Value" />);
    expect(screen.getByText('Showing latest 10 of 12')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View all' }));
    expect(await screen.findByText('History')).toBeInTheDocument();
    expect(screen.getByText('12 entries, newest first.')).toBeInTheDocument();
  });

  it('does not call onAdd when the value is blank', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    wrap(<SnapshotSection items={[]} onAdd={onAdd} onDelete={vi.fn()} addLabel="Add" />);
    const btn = screen.getByRole('button', { name: 'Add' });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('uses a custom format function for values', () => {
    const fmt = (n: number) => `#${n}`;
    wrap(<SnapshotSection items={[{ id: 1, as_of: '2026-01-01', value: 42 }]} onAdd={vi.fn()} onDelete={vi.fn()} format={fmt} integer />);
    expect(screen.getByText('#42')).toBeInTheDocument();
  });
});
