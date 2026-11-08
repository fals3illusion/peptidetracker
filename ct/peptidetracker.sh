#!/usr/bin/env bash
# PeptideTracker — create a Debian 13 LXC on Proxmox VE and install the app in it.
# Run in the Proxmox VE host shell (as root):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/fals3illusion/peptidetracker/main/ct/peptidetracker.sh)"
#
# Answer "n" at the first question to choose your own settings. Every setting can also be
# given as an environment variable (PT_CTID, PT_HOSTNAME, PT_CORES, PT_RAM, PT_DISK, PT_STORAGE,
# PT_TEMPLATE_STORAGE, PT_BRIDGE, PT_IP (dhcp or 192.168.1.50/24), PT_GW, PT_VLAN, PT_DEFAULTS=1).
set -euo pipefail

REPO="fals3illusion/peptidetracker"
BASE="${PT_BASE:-https://raw.githubusercontent.com/$REPO/main}"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; off=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$bold" "$off" "$*"; }
ok()   { printf ' %s✓%s %s\n' "$grn" "$off" "$*"; }
die()  { printf '%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }
ask()  { # ask "Question" default  -> echoes answer
  local a; read -r -p "  $1 [$2]: " a </dev/tty || true; echo "${a:-$2}"; }

cat <<EOF

${bold}  ____            _   _     _     _____               _
 |  _ \\ ___ _ __ | |_(_) __| | __|_   _| __ __ _  ___| | _____ _ __
 | |_) / _ \\ '_ \\| __| |/ _\` |/ _ \\| || '__/ _\` |/ __| |/ / _ \\ '__|
 |  __/  __/ |_) | |_| | (_| |  __/| || | | (_| | (__|   <  __/ |
 |_|   \\___| .__/ \\__|_|\\__,_|\\___||_||_|  \\__,_|\\___|_|\\_\\___|_|
           |_|${off}
  Self-hosted tracker for peptide and GLP-1 shots, vials, inventory and progress.

${yel}  Disclaimer:${off} PeptideTracker is a personal logging tool for educational and research
  purposes. It is not medical advice, does not sell or supply any substance, and is not
  affiliated with any manufacturer. Many peptides are not approved for human use — know
  your local laws and talk to a doctor. Provided as-is, with no warranty.

EOF

[ "$(id -u)" = 0 ] || die "Run this as root in the Proxmox VE host shell."
command -v pct >/dev/null && command -v pveam >/dev/null || die "This doesn't look like a Proxmox VE host (pct/pveam not found)."

if [ "${PT_DEFAULTS:-}" != 1 ]; then
  read -r -p "  Continue? [Y/n]: " go </dev/tty || true
  [[ "${go:-y}" =~ ^[Yy] ]] || exit 0
fi

# ---- settings ----
CTID="${PT_CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME_="${PT_HOSTNAME:-peptidetracker}"
CORES="${PT_CORES:-1}"
RAM="${PT_RAM:-512}"
DISK="${PT_DISK:-4}"
BRIDGE="${PT_BRIDGE:-vmbr0}"
IP="${PT_IP:-dhcp}"
GW="${PT_GW:-}"
VLAN="${PT_VLAN:-}"
pick_storage() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | head -1; }
STORAGE="${PT_STORAGE:-$(pick_storage rootdir)}"
TSTORAGE="${PT_TEMPLATE_STORAGE:-$(pick_storage vztmpl)}"

if [ "${PT_DEFAULTS:-}" != 1 ]; then
  echo
  echo "  Container: ID ${bold}$CTID${off}, ${bold}$CORES${off} core, ${bold}$RAM${off} MB RAM, ${bold}$DISK${off} GB disk on ${bold}$STORAGE${off}, network ${bold}$BRIDGE${off} ($IP)"
  read -r -p "  Use these settings? [Y/n]: " def </dev/tty || true
  if [[ ! "${def:-y}" =~ ^[Yy] ]]; then
    CTID=$(ask "Container ID" "$CTID")
    HOSTNAME_=$(ask "Hostname" "$HOSTNAME_")
    CORES=$(ask "CPU cores" "$CORES")
    RAM=$(ask "RAM (MB)" "$RAM")
    DISK=$(ask "Disk (GB)" "$DISK")
    echo "  ${dim}Storages for containers: $(pvesm status -content rootdir | awk 'NR>1 {printf "%s ", $1}')${off}"
    STORAGE=$(ask "Container storage" "$STORAGE")
    echo "  ${dim}Storages for templates: $(pvesm status -content vztmpl | awk 'NR>1 {printf "%s ", $1}')${off}"
    TSTORAGE=$(ask "Template storage" "$TSTORAGE")
    BRIDGE=$(ask "Network bridge" "$BRIDGE")
    IP=$(ask "IP address (dhcp, or e.g. 192.168.1.50/24)" "$IP")
    [ "$IP" != dhcp ] && GW=$(ask "Gateway" "${GW:-$(ip route | awk '/^default/ {print $3; exit}')}")
    VLAN=$(ask "VLAN tag (blank for none)" "$VLAN")
  fi
fi

[[ "$CTID" =~ ^[0-9]+$ ]] || die "Container ID must be a number."
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists."
[ -n "$STORAGE" ] || die "No storage for containers found (pvesm status -content rootdir)."
[ -n "$TSTORAGE" ] || die "No storage for templates found (pvesm status -content vztmpl)."
if [ "$IP" != dhcp ]; then
  [[ "$IP" =~ ^[0-9.]+/[0-9]+$ ]] || die "IP must be dhcp or look like 192.168.1.50/24."
fi

# ---- template ----
say "Finding the Debian 13 template"
pveam update >/dev/null 2>&1 || true
TEMPLATE=$(pveam available --section system 2>/dev/null | awk '/debian-13-standard/ {print $2}' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || die "Couldn't find a debian-13-standard template (pveam available --section system)."
if ! pveam list "$TSTORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  say "Downloading $TEMPLATE to $TSTORAGE"
  pveam download "$TSTORAGE" "$TEMPLATE" >/dev/null
fi
ok "$TEMPLATE"

# ---- create + start ----
NET="name=eth0,bridge=$BRIDGE,ip=$IP"
[ "$IP" != dhcp ] && [ -n "$GW" ] && NET="$NET,gw=$GW"
[ -n "$VLAN" ] && NET="$NET,tag=$VLAN"
TZ_HOST=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)

say "Creating container $CTID ($HOSTNAME_)"
pct create "$CTID" "$TSTORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_" --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$STORAGE:$DISK" --net0 "$NET" \
  --unprivileged 1 --features nesting=1 --onboot 1 --timezone host \
  --tags peptidetracker --ostype debian \
  --description "PeptideTracker — https://github.com/$REPO (update: run 'update' in this container's console)" >/dev/null
ok "Created"
pct start "$CTID"

say "Waiting for the network"
for i in $(seq 60); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  [ "$i" = 60 ] && die "The container has no network/DNS. Check the bridge and IP settings."
  sleep 2
done
ok "Online"

# ---- install inside ----
say "Installing PeptideTracker inside the container (a minute or two)"
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
curl -fsSL "$BASE/install/peptidetracker-install.sh" -o "$tmp" || die "Couldn't download the install script."
pct push "$CTID" "$tmp" /root/peptidetracker-install.sh --perms 0755
pct exec "$CTID" -- env PT_TZ="$TZ_HOST" ${PT_TARBALL_BASE:+PT_TARBALL_BASE="$PT_TARBALL_BASE"} bash /root/peptidetracker-install.sh
pct exec "$CTID" -- rm -f /root/peptidetracker-install.sh

ADDR=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

${grn}${bold}  PeptideTracker is running!${off}

  Open:   ${bold}http://$ADDR:3080${off}
          First visit: create your admin account — or "Restore from a PostgreSQL backup"
          if you're moving from another install.
  Then:   ⋯ → Admin walks you through email, adding people, the database backup and Grafana.
  Update: open the container's console and type ${bold}update${off}

  Phone notifications and "Add to Home Screen" need HTTPS: put it behind a reverse proxy
  (Nginx Proxy Manager, Caddy, Traefik…) with a certificate. See the README for details.

EOF
