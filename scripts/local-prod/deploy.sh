#!/usr/bin/env bash
# Deploy a tagged release (see scripts/release.sh): build the image, apply
# migrations, refresh the restricted app role, and (re)start the stack, then run a
# read-only browser smoke test. Safe to re-run; the same order the AWS deploy follows
# (DEPLOY.md steps 1, 4, 4b, 6). Refuses a release that skipped the release checks,
# or when there's no restore drill (scripts/local-prod/restore-drill.sh) in the last
# 30 days.
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

# The release checks (scripts/check.sh) ran on this tag: release.sh records it.
if [ "${ALLOW_UNRELEASED:-}" != 1 ] && [ "${ALLOW_UNCHECKED:-}" != 1 ]; then
  git tag -l --format='%(contents)' "v$version" | grep -q '^Release checks passed' || {
    echo "v$version was tagged without passing the release checks (scripts/check.sh). Cut releases with scripts/release.sh. ALLOW_UNCHECKED=1 overrides (emergencies only)." >&2
    exit 1
  }
fi

# A backup has been restored, and its secrets read, recently: scripts/local-prod/
# restore-drill.sh. SKIP_RESTORE_DRILL=1 overrides (e.g. the first deploy that has
# the drill, whose image the drill needs).
if [ "${SKIP_RESTORE_DRILL:-}" != 1 ]; then
  drill=.release-state/restore-drill
  [ -f "$drill" ] || { echo "No restore drill on record. Run scripts/local-prod/restore-drill.sh first." >&2; exit 1; }
  age=$(( ($(date +%s) - $(grep '^epoch=' "$drill" | cut -d= -f2)) / 86400 ))
  [ "$age" -le 30 ] || { echo "The last restore drill was $age days ago (limit 30). Run scripts/local-prod/restore-drill.sh." >&2; exit 1; }
  if grep -qE '^OFFSITE_BUCKET=.+' "$ENV_FILE" && ! grep -q '^backup_source=off-machine' "$drill"; then
    echo "Backups go to a bucket, but the last restore drill used the local folder. Run scripts/local-prod/restore-drill.sh again." >&2
    exit 1
  fi
  grep -q '^key_source=off-machine' "$drill" || echo "Warning: the last restore drill used the APP_SECRET_KEY in $ENV_FILE, not your off-machine copy." >&2
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
    # Read-only browser check of the live app (no changes to data).
    node e2e/smoke.mjs --url http://localhost:4100 || { echo "Doric v$version is up but failed the browser smoke test; check it now." >&2; exit 1; }
    echo "Doric v$version is up: http://localhost:4100"
    exit 0
  fi
  sleep 1
done
echo "App did not become ready; recent logs:" >&2
dc logs --tail 50 app >&2
exit 1
