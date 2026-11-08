#!/usr/bin/env bash
# For development: ship the code in this folder straight to your own PeptideTracker container
# (without making a release), rolling back if it doesn't start.
#   PT_DEV_HOST=my-ssh-alias scripts/dev-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${PT_DEV_HOST:?Set PT_DEV_HOST to the SSH host of your PeptideTracker container}"

echo "==> Running tests"
TZ=America/Chicago npm test >/dev/null

echo "==> Building bundle"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"; npm ci --silent' EXIT
npm ci --omit=dev --silent
tar -czf "$tmp/app.tgz" package.json package-lock.json server.js set-password.js lib public scripts node_modules CHANGELOG.md LICENSE README.md

echo "==> Uploading and switching over"
scp -q "$tmp/app.tgz" "$HOST:/tmp/pt-app.tgz"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
APP=/opt/peptidetracker DATA=/var/lib/peptidetracker SVC=peptidetracker
PORT=$(awk -F= '/^PORT=/ {print $2}' /etc/peptidetracker/env); PORT=${PORT:-3080}
mkdir -p /var/backups/peptidetracker
tar -czf /var/backups/peptidetracker/data-$(date +%Y%m%d-%H%M%S)-dev.tgz -C /var/lib peptidetracker
ls -1t /var/backups/peptidetracker/data-*.tgz | tail -n +11 | xargs -r rm -f
rm -rf $APP.new && mkdir -p $APP.new && tar -xzf /tmp/pt-app.tgz -C $APP.new && rm -f /tmp/pt-app.tgz
chown -R root:root $APP.new
rm -rf $APP.old && mv $APP $APP.old && mv $APP.new $APP
systemctl restart $SVC
for i in $(seq 20); do curl -fsS http://127.0.0.1:$PORT/api/auth >/dev/null 2>&1 && { install -m 0755 $APP/scripts/update.sh /usr/local/bin/peptidetracker-update; echo "==> Up and running"; exit 0; }; sleep 1; done
echo "!! New version didn't start, rolling back"; journalctl -u $SVC -n 20 --no-pager
rm -rf $APP && mv $APP.old $APP && systemctl restart $SVC
exit 1
REMOTE
