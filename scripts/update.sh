#!/usr/bin/env bash
# PeptideTracker updater — run `update` in the container's console.
#   update           install the newest release if there is one
#   update --force   reinstall the newest release
# Your data is backed up to /var/backups/peptidetracker first (last 10 kept); if the new
# version doesn't start, the old one is put back automatically.
set -euo pipefail

REPO="fals3illusion/peptidetracker"
TARBALL_BASE="${PT_TARBALL_BASE:-https://github.com/$REPO/releases/latest/download}"
APP=/opt/peptidetracker
DATA=/var/lib/peptidetracker
BACKUPS=/var/backups/peptidetracker
SVC=peptidetracker
PORT=$(awk -F= '/^PORT=/ {print $2}' /etc/peptidetracker/env 2>/dev/null || true); PORT=${PORT:-3080}

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run as root."
[ -d "$APP" ] || die "PeptideTracker isn't installed here ($APP not found)."

CURRENT=$(node -p "require('$APP/package.json').version")
if [ -z "${PT_TARBALL_BASE:-}" ]; then
  LATEST=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).tag_name||"").replace(/^v/,""))}catch{}})') \
    || die "Couldn't reach GitHub to check for updates."
  [ -n "$LATEST" ] || die "No releases found."
  if [ "${1:-}" != "--force" ] && [ "$(printf '%s\n%s\n' "$CURRENT" "$LATEST" | sort -V | tail -1)" = "$CURRENT" ]; then
    say "Already up to date (v$CURRENT)."; exit 0
  fi
  say "Updating v$CURRENT → v$LATEST"
else
  say "Updating from $TARBALL_BASE"
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$TARBALL_BASE/peptidetracker.tar.gz" -o "$tmp/app.tgz" || die "Download failed."
curl -fsSL "$TARBALL_BASE/peptidetracker.tar.gz.sha256" -o "$tmp/app.sha256" || die "Checksum download failed."
(cd "$tmp" && echo "$(awk '{print $1}' app.sha256)  app.tgz" | sha256sum -c --quiet) || die "Checksum mismatch — nothing changed."

say "Backing up your data"
mkdir -p "$BACKUPS" && chmod 700 "$BACKUPS"
tar -czf "$BACKUPS/data-$(date +%Y%m%d-%H%M%S)-v$CURRENT.tgz" -C "$(dirname "$DATA")" "$(basename "$DATA")"
ls -1t "$BACKUPS"/data-*.tgz | tail -n +11 | xargs -r rm -f

say "Installing"
rm -rf "$APP.new" && mkdir -p "$APP.new" && tar -xzf "$tmp/app.tgz" -C "$APP.new"
chown -R root:root "$APP.new"
rm -rf "$APP.old" && mv "$APP" "$APP.old" && mv "$APP.new" "$APP"
systemctl restart "$SVC"
for _ in $(seq 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/auth" >/dev/null 2>&1; then
    NEW=$(node -p "require('$APP/package.json').version")
    install -m 0755 "$APP/scripts/update.sh" /usr/local/bin/peptidetracker-update
    rm -rf "$APP.old"
    say "Done — PeptideTracker v$NEW is running."
    # What's new: this version's section of the changelog.
    [ -f "$APP/CHANGELOG.md" ] && awk -v v="$NEW" '$0 ~ "^## \\[" v "\\]" {on=1; print ""; next} on && /^## \[/ {exit} on' "$APP/CHANGELOG.md"
    exit 0
  fi
  sleep 1
done
journalctl -u "$SVC" -n 20 --no-pager || true
printf '\033[31m✗ The new version didn'"'"'t start — putting v%s back.\033[0m\n' "$CURRENT" >&2
rm -rf "$APP" && mv "$APP.old" "$APP" && systemctl restart "$SVC"
exit 1
