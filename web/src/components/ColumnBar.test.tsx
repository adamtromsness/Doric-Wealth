import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ColumnBar } from './ColumnBar';

// ColumnBar is a Recharts <Bar shape>; render it inside an <svg> so its
// <g>/<rect> output is valid. We drive each branch by props.
const renderShape = (props: any) => render(<svg>{ColumnBar(props)}</svg> as any).container;

describe('ColumnBar', () => {
  it('returns null when height or width is non-positive', () => {
    expect(ColumnBar({ x: 0, y: 0, width: 0, height: 10, fill: 'red' })).toBeNull();
    expect(ColumnBar({ x: 0, y: 0, width: 10, height: 0, fill: 'red' })).toBeNull();
    expect(ColumnBar({ x: 0, y: 0, width: 10, height: -5, fill: 'red' })).toBeNull();
  });

  it('renders a plain rounded rect when too small to be a column', () => {
    const c = renderShape({ x: 5, y: 5, width: 4, height: 8, fill: 'blue' });
    const rects = c.querySelectorAll('rect');
    expect(rects.length).toBe(1);
    expect(rects[0].getAttribute('fill')).toBe('blue');
    // No <g> wrapper for the plain-bar branch.
    expect(c.querySelector('g')).toBeNull();
  });

  it('renders a column with capital + shaft and no flutes for a narrow shaft', () => {
    const c = renderShape({ x: 10, y: 20, width: 8, height: 60, fill: 'green' });
    expect(c.querySelector('g')).not.toBeNull();
    // capital + shaft = 2 rects, no flutes (width < 12).
    expect(c.querySelectorAll('rect').length).toBe(2);
  });

  it('renders two flutes for a medium-width column', () => {
    const c = renderShape({ x: 10, y: 20, width: 14, height: 60, fill: 'green' });
    // capital + shaft + 2 flutes.
    expect(c.querySelectorAll('rect').length).toBe(4);
  });

  it('renders three flutes for a wide column', () => {
    const c = renderShape({ x: 10, y: 20, width: 24, height: 80, fill: 'green' });
    // capital + shaft + 3 flutes.
    expect(c.querySelectorAll('rect').length).toBe(5);
  });
});
