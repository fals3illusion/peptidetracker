#!/usr/bin/env bash
# Installs the `update` command and the "Update now" button's helper (run as root).
# The app itself runs unprivileged and can't replace its own files. When the admin clicks
# "Update now" it only creates /var/lib/peptidetracker/update-request; systemd notices that
# file and runs the normal updater (backup, install, restart, roll back on failure) as root.
set -euo pipefail
APP=/opt/peptidetracker
DATA=/var/lib/peptidetracker

install -m 0755 "$APP/scripts/update.sh" /usr/local/bin/peptidetracker-update
# `update` is what Proxmox helper-script containers use; keep it if something else owns it.
if [ ! -e /usr/bin/update ] || grep -q peptidetracker /usr/bin/update 2>/dev/null; then
  printf '#!/usr/bin/env bash\nexec /usr/local/bin/peptidetracker-update "$@"\n' > /usr/bin/update
  chmod 0755 /usr/bin/update
fi

cat > /etc/systemd/system/peptidetracker-update.service <<EOF
[Unit]
Description=PeptideTracker update (started from the app's Update now button)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/peptidetracker-update --from-web
EOF

cat > /etc/systemd/system/peptidetracker-update.path <<EOF
[Unit]
Description=Watch for PeptideTracker update requests

[Path]
PathExists=$DATA/update-request
Unit=peptidetracker-update.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable -q --now peptidetracker-update.path
