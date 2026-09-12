import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DoricMark, DoricBadge } from './DoricMark';

describe('DoricMark', () => {
  it('renders an svg at the default size with the column glyph', () => {
    const { container } = render(<DoricMark />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('aria-label', 'Doric');
    // 5 flutes + abacus + capital + base + plinth = 9 rects.
    expect(svg.querySelectorAll('rect').length).toBe(9);
  });

  it('honors a custom size and className', () => {
    const { container } = render(<DoricMark size={48} className="mark" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '48');
    expect(svg).toHaveClass('mark');
  });
});

describe('DoricBadge', () => {
  it('renders a circle badge with default colors', () => {
    const { container } = render(<DoricBadge />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '32');
    const circle = svg.querySelector('circle')!;
    expect(circle).toHaveAttribute('fill', 'var(--navy)');
  });

  it('honors custom size, bg, fg and className', () => {
    const { container } = render(<DoricBadge size={50} bg="#000" fg="#fff" className="badge" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '50');
    expect(svg).toHaveClass('badge');
    expect(svg.querySelector('circle')).toHaveAttribute('fill', '#000');
    expect(svg.querySelector('g')).toHaveAttribute('fill', '#fff');
  });
});
