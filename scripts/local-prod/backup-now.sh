#!/usr/bin/env bash
# Take an on-demand backup (e.g. before a deploy), in addition to the nightly one.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T backup \
  sh -c 'f=/backups/doric-$(date -u +%Y%m%dT%H%M%SZ)-manual.dump && pg_dump -Fc -f "$f" && echo "backup ok: $f"'
