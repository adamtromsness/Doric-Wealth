#!/usr/bin/env bash
# Restore drill: prove the newest backup can be restored and its secrets read, the
# way you'd recover after losing this machine. It takes the newest dump from the
# off-machine bucket (or, without OFFSITE_BUCKET, the local backup folder), restores
# it into a scratch database, and checks that the APP_SECRET_KEY you keep off this
# machine (paste it when asked) decrypts it. Then it drops the scratch database.
# deploy.sh requires a successful drill within the last 30 days.
#
#   scripts/local-prod/restore-drill.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
dc() { docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@"; }
envval() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
die() { echo "restore-drill: $*" >&2; exit 1; }
DRILL_DB=doric_drill
psql_admin() { dc exec -T db psql -U doric_admin -v ON_ERROR_STOP=1 "$@"; }

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  psql_admin -d postgres -qc "DROP DATABASE IF EXISTS $DRILL_DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. The newest backup, from off the machine when a bucket is set up.
bucket="$(envval OFFSITE_BUCKET)"
if [ -n "$bucket" ]; then
  source=off-machine
  rc() { dc --profile offsite run --rm --no-deps -T --user "$(id -u):$(id -g)" -e RCLONE_CONFIG=/dev/null -v "$work:/drill" --entrypoint sh offsite -c "$1"; }
  name="$(rc 'rclone lsf "$DEST" --include "doric-*.dump" | sort | tail -1' | tr -d '\r')"
  [ -n "$name" ] || die "no backups found in bucket $bucket."
  echo "Downloading $name from bucket $bucket…"
  rc "rclone copyto \"\$DEST/$name\" /drill/drill.dump"
else
  source=local
  dir="$(envval BACKUP_DIR)"
  name="$(cd "$dir" && ls -1 doric-*.dump 2>/dev/null | sort | tail -1)"
  [ -n "$name" ] || die "no backups found in $dir."
  echo "No OFFSITE_BUCKET set, so this drills the local copy: $dir/$name"
  cp "$dir/$name" "$work/drill.dump"
fi
[ -s "$work/drill.dump" ] || die "the downloaded backup is empty."

# 2. Restore it into a scratch database beside the real one.
echo "Restoring into scratch database $DRILL_DB…"
psql_admin -d postgres -qc "DROP DATABASE IF EXISTS $DRILL_DB WITH (FORCE)" -c "CREATE DATABASE $DRILL_DB"
dc exec -T db pg_restore -U doric_admin -d "$DRILL_DB" --no-owner --exit-on-error < "$work/drill.dump"
echo "Records (live → restored):"
for t in users books accounts transactions; do
  live="$(psql_admin -d doric -Atc "SELECT count(*) FROM $t")"
  restored="$(psql_admin -d "$DRILL_DB" -Atc "SELECT count(*) FROM $t")"
  echo "  $t: $live → $restored"
done

# 3. The key: the copy kept off this machine is the one a recovery would have.
key_source=server
key=""
if [ -t 0 ]; then
  echo
  echo "Paste the APP_SECRET_KEY you keep off this machine (e.g. your password manager) and press Enter."
  echo "Press Enter alone to use the copy in $ENV_FILE instead (that proves less)."
  read -rs key || true
  echo
fi
if [ -n "$key" ]; then
  key_source=off-machine
  [ "$key" = "$(envval APP_SECRET_KEY)" ] || echo "Note: that key differs from the one in $ENV_FILE."
else
  key="$(envval APP_SECRET_KEY)"
fi
APP_SECRET_KEY="$key" DATABASE_URL="postgresql://doric_admin:$(envval POSTGRES_PASSWORD)@db:5432/$DRILL_DB" \
  dc run --rm --no-deps -T -e APP_SECRET_KEY -e DATABASE_URL app node dist/keyCheck.js \
  || die "the key check failed: this key can't recover the backup's secrets. Nothing recorded."

mkdir -p .release-state
cat > .release-state/restore-drill <<EOF
date=$(date -u +%FT%TZ)
epoch=$(date +%s)
backup=$name
backup_source=$source
key_source=$key_source
EOF
echo
echo "Restore drill passed ($source backup $name, $key_source key). Recorded in .release-state/restore-drill."
