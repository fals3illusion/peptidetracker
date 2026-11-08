#!/usr/bin/env bash
# Cut a release: scripts/release.sh 1.1.0
# Turns "## [Unreleased]" in CHANGELOG.md into "## [1.1.0] - <date>", bumps package.json,
# commits, tags v1.1.0 and pushes. GitHub Actions then tests, builds and publishes the release.
#
# Re-publish an existing version with the current code (fixes folded in, same version number):
#   scripts/release.sh 1.0.0 --replace
# Notes stay in that version's changelog section; installs pick it up with `update --force`.
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: scripts/release.sh X.Y.Z [--replace]"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first."; exit 1; }
if [ "${2:-}" = "--replace" ]; then
  [ "$(node -p 'require("./package.json").version')" = "$V" ] || { echo "package.json isn't at $V."; exit 1; }
  grep -q "^## \[$V\]" CHANGELOG.md || { echo "No '## [$V]' section in CHANGELOG.md."; exit 1; }
  TZ=America/Chicago npm test >/dev/null
  git push -q origin main
  git tag -fa "v$V" -m "PeptideTracker v$V"
  git push -q -f origin "v$V"
  echo "Re-published v$V — GitHub Actions is rebuilding the release."
  exit 0
fi
git rev-parse "v$V" >/dev/null 2>&1 && { echo "v$V already exists."; exit 1; }
notes=$(awk '/^## \[Unreleased\]/ {on=1; next} on && /^## \[/ {exit} on' CHANGELOG.md | grep -v '^\s*$' || true)
[ -n "$notes" ] || { echo "Nothing under '## [Unreleased]' in CHANGELOG.md."; exit 1; }

TZ=America/Chicago npm test >/dev/null
npm version "$V" --no-git-tag-version --allow-same-version >/dev/null
today=$(date +%Y-%m-%d)
sed -i "s/^## \[Unreleased\]/## [Unreleased]\n\n## [$V] - $today/" CHANGELOG.md
git add package.json package-lock.json CHANGELOG.md
git commit -q -m "Release v$V"
git tag -a "v$V" -m "PeptideTracker v$V"
git push -q origin main "v$V"
echo "Pushed v$V — GitHub Actions is building the release."
