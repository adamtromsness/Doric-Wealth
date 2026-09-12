import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// ── jsdom gaps used across the app ─────────────────────────────────────────
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
window.HTMLElement.prototype.scrollIntoView = vi.fn();
if (!window.URL.createObjectURL) window.URL.createObjectURL = vi.fn(() => 'blob:mock');
if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = vi.fn();

// ── recharts under jsdom ───────────────────────────────────────────────────
// ResponsiveContainer measures its parent, which is 0×0 in jsdom, so its chart
// child never renders. Replace it with a fixed-size wrapper that injects real
// dimensions into the chart so charts render deterministically in tests.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children, width = 800, height = 400 }: any) =>
      React.isValidElement(children) ? (
        <div style={{ width, height }}>
          {React.cloneElement(children as React.ReactElement, { width: 800, height: 400 })}
        </div>
      ) : (
        <div style={{ width, height }}>{children}</div>
      ),
  };
});
