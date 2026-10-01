#!/usr/bin/env bash
# Manage signup invites on the production-mode local stack. Sign-up is invite-only
# there, so each new person (with their own books) needs one of these links.
#
#   scripts/local-prod/invite.sh create [--email person@example.com] [--days 14] [--note "Mom"]
#   scripts/local-prod/invite.sh list
#   scripts/local-prod/invite.sh revoke <id>
#
# To add someone to one of YOUR books instead, create a book invite in the app
# (user menu → My Books → New Invite Link); that link works for sign-up too.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps -T app node dist/signupInvites.js "$@"
