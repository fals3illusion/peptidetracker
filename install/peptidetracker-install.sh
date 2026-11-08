#!/usr/bin/env bash
# PeptideTracker — install inside a Debian 12/13 container or VM (run as root).
# Normally started by ct/peptidetracker.sh on the Proxmox host, but works on its own too:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/fals3illusion/peptidetracker/main/install/peptidetracker-install.sh)"
set -euo pipefail

REPO="fals3illusion/peptidetracker"
TARBALL_BASE="${PT_TARBALL_BASE:-https://github.com/$REPO/releases/latest/download}"
APP=/opt/peptidetracker
DATA=/var/lib/peptidetracker
CONF=/etc/peptidetracker
PORT="${PT_PORT:-3080}"
SVC=peptidetracker

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run as root."

say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
# Avoid "Setting locale failed" noise when the caller's language isn't installed here.
locale -a 2>/dev/null | grep -qi "^${LANG%%.*}" || export LANG=C.UTF-8 LC_ALL=C.UTF-8
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar nodejs >/dev/null
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is needed (found $(node -v)). Use Debian 13, or install Node 20+ first."

say "Downloading the latest release"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$TARBALL_BASE/peptidetracker.tar.gz" -o "$tmp/app.tgz" || die "Download failed: $TARBALL_BASE/peptidetracker.tar.gz"
curl -fsSL "$TARBALL_BASE/peptidetracker.tar.gz.sha256" -o "$tmp/app.sha256" || die "Checksum download failed."
(cd "$tmp" && echo "$(awk '{print $1}' app.sha256)  app.tgz" | sha256sum -c --quiet) || die "Checksum mismatch — download corrupted."
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf "$tmp/app.tgz" -C "$APP.new"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
chown -R root:root "$APP"
VERSION=$(node -p "require('$APP/package.json').version")

say "Creating the service user and folders"
id "$SVC" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$SVC"
mkdir -p "$DATA" "$CONF"
chown "$SVC:$SVC" "$DATA" && chmod 700 "$DATA"
if [ ! -s "$CONF/env" ]; then
  TZ_="${PT_TZ:-$(cat /etc/timezone 2>/dev/null || echo UTC)}"
  umask 077
  cat > "$CONF/env" <<EOF
PORT=$PORT
DATA_DIR=$DATA
TZ=$TZ_
NODE_ENV=production
# Optional: mirror everything to PostgreSQL (and restore from it on a fresh install):
# PG_URL=postgres://user:password@host:5432/database
# Optional: turn off the daily check for new versions:
# UPDATE_CHECK=0
EOF
  chown "root:$SVC" "$CONF/env" && chmod 640 "$CONF/env"
fi

say "Installing the service"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=PeptideTracker
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC
Group=$SVC
EnvironmentFile=$CONF/env
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/server.js
Restart=always
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
bash "$APP/scripts/install-units.sh"   # the `update` command and the app's "Update now" button
systemctl daemon-reload
systemctl enable -q "$SVC"
systemctl restart "$SVC"

for i in $(seq 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/auth" >/dev/null 2>&1 && break
  [ "$i" = 20 ] && { journalctl -u "$SVC" -n 20 --no-pager; die "The app didn't start (journalctl -u $SVC)."; }
  sleep 1
done
rm -rf "$APP.old"
say "PeptideTracker v$VERSION is running on port $PORT"
