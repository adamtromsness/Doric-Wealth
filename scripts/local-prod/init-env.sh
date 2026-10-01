#!/usr/bin/env bash
# One-time: generate .env.production with fresh random secrets. Refuses to
# overwrite an existing file — APP_SECRET_KEY must stay the same for the life of
# the data (it decrypts stored SimpleFIN credentials), including after the move to AWS.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=.env.production
if [ -e "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; not overwriting." >&2
  exit 1
fi
BACKUP_DIR="${BACKUP_DIR:-/mnt/c/Users/adamt/DoricBackups}"
mkdir -p "$BACKUP_DIR"
umask 077
cat > "$ENV_FILE" <<ENV
# Doric production-mode local stack. NEVER commit this file.
# Save APP_SECRET_KEY in your password manager: AWS must use the same value.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_DB_USER=doric_app
APP_DB_PASSWORD=$(openssl rand -hex 24)
APP_SECRET_KEY=$(openssl rand -base64 32)
BACKUP_DIR=$BACKUP_DIR
BACKUP_KEEP_DAYS=30
# Optional integrations:
ANTHROPIC_API_KEY=
RENTCAST_API_KEY=
ENV
echo "Wrote $ENV_FILE (mode 600). Backups will go to $BACKUP_DIR."
