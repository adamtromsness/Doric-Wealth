#!/usr/bin/env bash
# Delete a person's account and data at their request. Prints what it would do;
# add --yes to delete. Books only they belong to are deleted; from shared books
# they're removed. If they solely own a shared book, name a member of it to take
# it over with --new-owner. Their data stays in backups until those expire.
#
#   scripts/local-prod/delete-account.sh person@example.com [--new-owner other@example.com] [--yes]
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps -T app node dist/deleteAccount.js "$@"
