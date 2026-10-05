#!/usr/bin/env bash
# Release checks (scripts/release.sh runs these before tagging): every server test,
# with the coverage gate, then again as a restricted database role so row-level
# security is enforced as in production; the web tests with their coverage gate and a
# production build; and the browser smoke test against a throwaway app. Needs the dev
# Postgres (docker compose up -d db) and e2e/setup.sh run once.
set -euo pipefail
cd "$(dirname "$0")/.."
run() { echo; echo "== $1"; shift; "$@"; }
run "Server tests (coverage gate)" bash -c 'cd server && npm run test:coverage:gate'
run "Server tests as a restricted role (row-level security)" bash -c 'cd server && TEST_RESTRICTED_ROLE=1 npm run test:integration'
run "Web tests (coverage gate)" bash -c 'cd web && npm run test:coverage:gate'
run "Web production build" bash -c 'cd web && npm run build'
run "Browser smoke test" node e2e/smoke.mjs
echo; echo "All release checks passed."
