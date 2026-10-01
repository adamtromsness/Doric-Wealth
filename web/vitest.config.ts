import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Mirrors vite.config.ts so components that read __APP_VERSION__ behave in tests
// exactly as they do in a real build.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// Release notes (repo-root CHANGELOG.md) for the What's New page, as __APP_CHANGELOG__.
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

// Test config for the web app. Runs under jsdom with React Testing Library.
// Coverage thresholds are added in Phase 4 once the suite reaches 90%.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_CHANGELOG__: JSON.stringify(changelog),
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.tsx'],
    css: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',        // DOM bootstrap (createRoot) — nothing to assert
        'src/types.ts',        // type-only declarations
        'src/**/*.d.ts',
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
      ],
      reporter: ['text', 'lcov'],
    },
  },
});
