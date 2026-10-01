#!/bin/sh
# Runs inside the doric-local `backup` container (see docker-compose.prod.yml).
# Dumps the database in pg_dump custom format, then prunes old dumps.
set -u
while true; do
  f="/backups/doric-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump -Fc -f "$f.partial"; then
    mv "$f.partial" "$f"
    echo "$(date -u +%FT%TZ) backup ok: $f ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.partial"
    echo "$(date -u +%FT%TZ) backup FAILED" >&2
  fi
  find /backups -name 'doric-*.dump' -mtime +"$KEEP_DAYS" -delete
  sleep 86400
done
