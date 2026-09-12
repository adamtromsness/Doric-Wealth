import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  BackLink, Loading, AmountInput, Modal, AiOutput, DragHandle, EditIcon, Field, Toggle,
  EditorSection, FormSection, EditorFooter, SectionHeader,
  arrayMove, slotReorder, cap, kindAccent, CHART_COLORS, chartTooltip, AMOUNT_OPS, fileToBase64, useDirty,
} from './ui';

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('pure helpers', () => {
  it('arrayMove moves an element', () => {
    expect(arrayMove([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(arrayMove([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  });
  it('slotReorder reorders displayed ids keeping hidden ids in place', () => {
    // full = [10(hidden),1,2,3], displayed=[1,2,3] -> newDisplayed=[3,1,2]
    expect(slotReorder([10, 1, 2, 3], [1, 2, 3], [3, 1, 2])).toEqual([10, 3, 1, 2]);
  });
  it('cap capitalizes the first letter and tolerates blanks', () => {
    expect(cap('hello')).toBe('Hello');
    expect(cap('')).toBe('');
    expect(cap(null)).toBe('');
    expect(cap(undefined)).toBe('');
  });
  it('kindAccent maps income/expense to CSS vars', () => {
    expect(kindAccent('income')).toBe('var(--income)');
    expect(kindAccent('expense')).toBe('var(--expense)');
  });
  it('exposes chart constants', () => {
    expect(CHART_COLORS.length).toBeGreaterThan(4);
    expect(chartTooltip.fontSize).toBe(12);
    expect(AMOUNT_OPS[0]).toEqual(['', 'Any']);
  });
});

describe('fileToBase64', () => {
  it('reads a file into base64 payload + mime + name', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const out = await fileToBase64(file);
    expect(out.name).toBe('note.txt');
    expect(out.mime).toBe('text/plain');
    expect(atob(out.data)).toBe('hello');
  });
  it('defaults the mime when the file has none', async () => {
    const file = new File(['x'], 'blob', { type: '' });
    const out = await fileToBase64(file);
    expect(out.mime).toBe('application/octet-stream');
  });
});

describe('BackLink & Loading', () => {
  it('BackLink renders a labeled link to the target', () => {
    wrap(<BackLink to="/accounts" label="Back to Accounts" />);
    const link = screen.getByRole('link', { name: /Back to Accounts/ });
    expect(link).toHaveAttribute('href', '/accounts');
  });
  it('Loading renders plain, card, and back-link variants', () => {
    const { rerender } = wrap(<Loading />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    rerender(<MemoryRouter><Loading card /></MemoryRouter>);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    rerender(<MemoryRouter><Loading card backTo="/x" backLabel="Back" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Back/ })).toBeInTheDocument();
  });
});

describe('AmountInput', () => {
  it('displays two decimals at rest, raw while focused, and normalizes on blur', async () => {
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState('6');
      return <AmountInput value={v} onChange={setV} aria-label="amt" />;
    }
    wrap(<Host />);
    const input = screen.getByLabelText('amt') as HTMLInputElement;
    expect(input.value).toBe('6.00'); // at rest
    await user.click(input);
    expect(input.value).toBe('6'); // focused shows raw
    await user.clear(input);
    await user.type(input, '5.5');
    await user.tab(); // blur normalizes
    expect(input.value).toBe('5.50');
  });
  it('keeps blank blank', () => {
    wrap(<AmountInput value="" onChange={() => {}} aria-label="amt2" />);
    expect((screen.getByLabelText('amt2') as HTMLInputElement).value).toBe('');
  });
});

describe('Modal', () => {
  it('renders title/subtitle/children and closes on scrim click', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<Modal title="Edit" subtitle="sub" onClose={onClose}><p>body</p></Modal>);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('sub')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    await user.click(document.querySelector('.scrim')!);
    expect(onClose).toHaveBeenCalled();
  });
  it('persistent modal ignores scrim clicks', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<Modal title="T" onClose={onClose} persistent><p>b</p></Modal>);
    await user.click(document.querySelector('.scrim')!);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('AiOutput (XSS-hardened markdown)', () => {
  it('renders markdown and keeps safe links, dropping javascript: urls', () => {
    const { container } = wrap(<AiOutput markdown={'# Hi\n\n[ok](https://a.com) [bad](javascript:alert(1))'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Hi');
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(1);
    expect(links[0].getAttribute('href')).toBe('https://a.com');
  });
  it('escapes raw HTML in the source', () => {
    const { container } = wrap(<AiOutput markdown={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('small components', () => {
  it('DragHandle fires onStart with its index', async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    wrap(<DragHandle index={3} onStart={onStart} onEnd={onEnd} />);
    const grip = screen.getByTitle('Drag to reorder');
    // jsdom lacks a full DnD; fire the drag events directly.
    grip.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(onStart).toHaveBeenCalledWith(3);
  });
  it('EditIcon renders an svg', () => {
    const { container } = wrap(<EditIcon />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
  it('Field renders a label with its child', () => {
    wrap(<Field label="Name"><input aria-label="n" /></Field>);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('n')).toBeInTheDocument();
  });
  it('Toggle flips on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    wrap(<Toggle checked={false} onChange={onChange}>Enabled</Toggle>);
    await user.click(screen.getByText('Enabled'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('EditorSection & FormSection & SectionHeader render titles', () => {
    wrap(<><EditorSection title="Sec" /><FormSection title="Form" description="d"><p>c</p></FormSection><SectionHeader kind="income" title="Head" /></>);
    expect(screen.getByText('Sec')).toBeInTheDocument();
    expect(screen.getByText('Form')).toBeInTheDocument();
    expect(screen.getByText('Head')).toBeInTheDocument();
  });
});

describe('EditorFooter', () => {
  it('shows Delete only when onDelete is provided and wires actions', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn(), onSave = vi.fn(), onDelete = vi.fn();
    const { rerender } = wrap(<EditorFooter onClose={onClose} onSave={onSave} saveLabel="Save" />);
    expect(screen.queryByText('Delete')).toBeNull();
    rerender(<MemoryRouter><EditorFooter onClose={onClose} onSave={onSave} onDelete={onDelete} saveLabel="Save" /></MemoryRouter>);
    await user.click(screen.getByText('Delete'));
    await user.click(screen.getByText('Close'));
    await user.click(screen.getByText('Save'));
    expect(onDelete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalled();
  });
  it('shows a saving state and disables save', () => {
    wrap(<EditorFooter onClose={() => {}} onSave={() => {}} saveLabel="Save" saving />);
    expect(screen.getByText('Saving…')).toBeDisabled();
  });
});

describe('useDirty', () => {
  it('returns false until the value changes from its first render', async () => {
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState('a');
      const dirty = useDirty(v);
      return <><span data-testid="d">{String(dirty)}</span><button onClick={() => setV('b')}>chg</button></>;
    }
    wrap(<Host />);
    expect(screen.getByTestId('d')).toHaveTextContent('false');
    await user.click(screen.getByText('chg'));
    expect(screen.getByTestId('d')).toHaveTextContent('true');
  });
});
