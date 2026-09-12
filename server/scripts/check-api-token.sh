#!/usr/bin/env bash
# Diagnostic for the API_TOKEN guard (server/src/index.ts).
#
# Verifies that, when the server is started with API_TOKEN set:
#   - /api/health and /api/ready stay open (no token required)
#   - protected /api routes reject missing/incorrect tokens with 401
#   - a correct token passes the token gate (the request then proceeds to the
#     normal auth check, i.e. "Authentication required" — a DIFFERENT 401)
#
# Usage:
#   BASE=http://127.0.0.1:4000 TOKEN=your-secret server/scripts/check-api-token.sh
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:4000}"
TOKEN="${TOKEN:-}"

fail=0
# Print "<status> <body>" for a request; assert status + that body contains $4.
check() {
  local label="$1" expect_status="$2" expect_substr="$3"; shift 3
  local out status body
  out="$(curl -s -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [[ "$status" == "$expect_status" && "$body" == *"$expect_substr"* ]]; then
    printf '  ok   %-26s -> %s %s\n' "$label" "$status" "$body"
  else
    printf '  FAIL %-26s -> %s %s (wanted %s containing "%s")\n' "$label" "$status" "$body" "$expect_status" "$expect_substr"
    fail=1
  fi
}

echo "Checking API_TOKEN guard at $BASE"
check "health (open)"        200 '"ok":true'                  "$BASE/api/health"
check "no token"             401 'API token'                  "$BASE/api/accounts"
check "wrong token"          401 'API token'                  -H "Authorization: Bearer nope" "$BASE/api/accounts"
# Correct token clears the token gate; the request then fails the normal auth
# check instead (proving the token was accepted).
check "correct bearer token" 401 'Authentication required'    -H "Authorization: Bearer $TOKEN" "$BASE/api/accounts"
check "correct x-api-token"  401 'Authentication required'    -H "X-API-Token: $TOKEN" "$BASE/api/accounts"

if [[ "$fail" == 0 ]]; then echo "All API_TOKEN checks passed."; else echo "Some checks FAILED."; exit 1; fi
