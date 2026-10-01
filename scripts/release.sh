#!/usr/bin/env bash
# Cut a release: move CHANGELOG.md's Unreleased notes under a new dated version,
# bump the version in package.json (root, server, web — the web one is what the
# app's top bar shows), then commit and tag vX.Y.Z.
#
#   scripts/release.sh patch|minor|major
# Optional: RELEASE_TRAILER='Key: value' appends a trailer to the release commit.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "release: $*" >&2; exit 1; }

bump="${1:-}"
case "$bump" in patch|minor|major) ;; *) die "usage: scripts/release.sh patch|minor|major" ;; esac
[ "$(git branch --show-current)" = main ] || die "release from main (merge your branches first)."
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or stash first."

notes="$(awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f' CHANGELOG.md | sed '/^[[:space:]]*$/d')"
[ -n "$notes" ] || die "nothing under '## [Unreleased]' in CHANGELOG.md; add the changes first."

for d in . server web; do (cd "$d" && npm version "$bump" --no-git-tag-version >/dev/null); done
v="$(node -p "require('./web/package.json').version")"
for d in . server; do
  [ "$(node -p "require('./$d/package.json').version")" = "$v" ] || die "$d/package.json version differs from web ($v); align them by hand."
done
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && die "tag v$v already exists."

sed -i "s/^## \[Unreleased\]\$/## [Unreleased]\n\n## [$v] - $(date +%F)/" CHANGELOG.md

git add CHANGELOG.md package.json package-lock.json server/package.json server/package-lock.json web/package.json web/package-lock.json
git commit -q --cleanup=verbatim -m "Release v$v" -m "$notes" ${RELEASE_TRAILER:+--trailer "$RELEASE_TRAILER"}
git tag -a --cleanup=verbatim "v$v" -m "v$v" -m "$notes"
echo "Released v$v. Deploy with scripts/local-prod/deploy.sh; push with: git push origin main v$v"
