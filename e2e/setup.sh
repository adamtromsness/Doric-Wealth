#!/usr/bin/env bash
# One-time setup for the browser smoke test: install playwright-core and its
# headless Chromium. On Linux without the browser's system libraries and without
# root (e.g. WSL), fetch those libraries into ~/.cache/doric-smoke instead of
# installing them system-wide; smoke.mjs adds that folder to the browser's library path.
set -euo pipefail
cd "$(dirname "$0")"
npm install --no-audit --no-fund
npx playwright-core install chromium-headless-shell
shell="$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | sort | tail -1)"
if [ "$(uname)" = Linux ] && [ -n "$shell" ] && ldd "$shell" | grep -q 'not found'; then
  libs="$HOME/.cache/doric-smoke"
  tmp="$(mktemp -d)"
  (cd "$tmp" && apt-get download libnss3 libnspr4 "$(apt-cache show libasound2t64 >/dev/null 2>&1 && echo libasound2t64 || echo libasound2)")
  mkdir -p "$libs"
  for d in "$tmp"/*.deb; do dpkg -x "$d" "$libs"; done
  rm -rf "$tmp"
  missing="$(LD_LIBRARY_PATH="$libs/usr/lib/x86_64-linux-gnu" ldd "$shell" | grep 'not found' || true)"
  [ -z "$missing" ] || { echo "Still missing browser libraries:"; echo "$missing"; exit 1; }
  echo "Browser libraries installed in $libs"
fi
echo "Smoke test ready: node e2e/smoke.mjs"
