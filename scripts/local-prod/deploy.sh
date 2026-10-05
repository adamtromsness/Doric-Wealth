#!/usr/bin/env bash
# Deploy a tagged release (see scripts/release.sh): build the image, apply
# migrations, refresh the restricted app role, and (re)start the stack. Safe to
# re-run; the same order the AWS deploy follows (DEPLOY.md steps 1, 4, 4b, 6).
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — run scripts/local-prod/init-env.sh first." >&2; exit 1; }
dc() { docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@"; }

# Only tagged releases go to production, so the version in the app's top bar always
# matches a CHANGELOG.md entry. ALLOW_UNRELEASED=1 overrides (emergencies only).
version="$(node -p "require('./web/package.json').version")"
if [ "${ALLOW_UNRELEASED:-}" != 1 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Uncommitted changes would be built into the image; commit them and cut a release (scripts/release.sh)." >&2; exit 1; }
  [ "$(git describe --exact-match --tags HEAD 2>/dev/null)" = "v$version" ] || {
    echo "HEAD is not the tagged release v$version. Run scripts/release.sh patch|minor|major first." >&2
    exit 1
  }
fi
echo "Deploying v$version"

dc build app
dc up -d --wait db
dc run --rm --no-deps app node dist/migrate.js
# Re-grant after migrations so new tables are covered (DEPLOY.md step 4b).
dc run --rm --no-deps app node dist/setupDbRole.js
dc up -d app backup
# Off-machine backup copies, when a bucket is configured (see the offsite service).
if grep -qE '^OFFSITE_BUCKET=.+' "$ENV_FILE"; then dc --profile offsite up -d offsite; fi

for _ in $(seq 1 30); do
  if curl -fsS http://localhost:4100/api/ready >/dev/null 2>&1; then
    echo "Doric v$version is up: http://localhost:4100"
    exit 0
  fi
  sleep 1
done
echo "App did not become ready; recent logs:" >&2
dc logs --tail 50 app >&2
exit 1
