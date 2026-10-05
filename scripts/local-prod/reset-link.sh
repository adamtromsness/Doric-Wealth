#!/usr/bin/env bash
# Generate a one-time password reset link for a user (valid 24 hours by default) to
# send them yourself, e.g. when email isn't set up. Using it signs them out everywhere.
#
#   scripts/local-prod/reset-link.sh person@example.com [--hours 24]
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps -T app node dist/passwordReset.js "$@"
