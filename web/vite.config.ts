import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Expose the app version (from package.json) to the client as __APP_VERSION__.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// Release notes (repo-root CHANGELOG.md) for the What's New page, as __APP_CHANGELOG__.
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_CHANGELOG__: JSON.stringify(changelog),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
