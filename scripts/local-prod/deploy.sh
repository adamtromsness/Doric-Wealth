#!/usr/bin/env bash
# Build the image, apply migrations, refresh the restricted app role, and
# (re)start the stack. Safe to re-run for every update — the same order the
# AWS deploy follows (DEPLOY.md steps 1, 4, 4b, 6).
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — run scripts/local-prod/init-env.sh first." >&2; exit 1; }
dc() { docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@"; }

dc build app
dc up -d --wait db
dc run --rm --no-deps app node dist/migrate.js
# Re-grant after migrations so new tables are covered (DEPLOY.md step 4b).
dc run --rm --no-deps app node dist/setupDbRole.js
dc up -d app backup

for _ in $(seq 1 30); do
  if curl -fsS http://localhost:4100/api/ready >/dev/null 2>&1; then
    echo "Doric is up: http://localhost:4100"
    exit 0
  fi
  sleep 1
done
echo "App did not become ready; recent logs:" >&2
dc logs --tail 50 app >&2
exit 1
