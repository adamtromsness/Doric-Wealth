/// <reference types="vite/client" />

// Injected at build time by Vite's `define` (see vite.config.ts) — the app
// version from package.json.
declare const __APP_VERSION__: string;

// The repo-root CHANGELOG.md, injected the same way (shown on the What's New page).
declare const __APP_CHANGELOG__: string;
