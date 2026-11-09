# PeptideTracker

[![Latest release](https://img.shields.io/github/v/release/fals3illusion/peptidetracker?label=release)](https://github.com/fals3illusion/peptidetracker/releases/latest)
[![Tests](https://github.com/fals3illusion/peptidetracker/actions/workflows/release.yml/badge.svg)](https://github.com/fals3illusion/peptidetracker/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/fals3illusion/peptidetracker/pkgs/container/peptidetracker)

A self-hosted tracker for peptide and GLP-1 shots: vials and what's left in them, dose schedules,
injection-site rotation, inventory, reorder dates, reminders on your phone, and your weight trend
with a projected goal date. Runs in a small Proxmox LXC (or any Debian 12/13 machine), private to
you and the people you invite.

<p align="center">
  <img src="docs/screenshots/home-light.png" width="200" alt="Home: shot day, next shots and projected goal date">
  <img src="docs/screenshots/progress.png" width="200" alt="Weight chart with dose changes, and weight loss per dose">
  <img src="docs/screenshots/meds.png" width="200" alt="Medications: schedules, sites, vials and reorder dates">
  <img src="docs/screenshots/inventory.png" width="200" alt="Inventory and reorder planner">
</p>
<p align="center">
  <img src="docs/screenshots/getting-started.png" width="200" alt="Get started: add a medication, a vial, log your first shot">
  <img src="docs/screenshots/home-dark.png" width="200" alt="Home screen in dark mode">
</p>
<p align="center"><sub>Demo data. Works on your phone as a Home Screen app, in light and dark mode. New accounts start with a short Get started list.</sub></p>

> **Disclaimer:** PeptideTracker is a personal logging tool for educational and research purposes.
> It is not medical advice and doesn't recommend any dose, schedule or substance — dose plans and
> projections only follow the numbers you enter. It does not sell or supply anything and is not
> affiliated with any manufacturer or pharmacy. Many peptides are not approved for human use —
> know your local laws and talk to a doctor. Provided as-is, with no warranty (see [LICENSE](LICENSE)).

## Features

- **Shots & vials** — log a dose in mg or syringe units; the app works out units from powder mg +
  water mL, subtracts each shot from its vial, and shows what's left and cost per shot. Split a dose
  across two vials when one runs low. Correct a vial if what's actually left differs.
- **Schedules** — a weekly main GLP-1 with a shot day and an optional step-up dose plan; other
  peptides on their own schedule (daily, certain weekdays, every N days, as needed), in units or mg,
  with optional increases.
- **Next shots** at the top of the page, with one-tap **✓ Log** (and Undo).
- **Injection sites** — per-medication rotation with custom sites; the next site is suggested.
- **Inventory** — powder vials, bacteriostatic water and supplies with lot, expiry and low-stock
  warnings. "Mix & use" turns stock into a vial in use.
- **Reorder planner** — when each medication runs out and the date to order by (your lead time,
  per medication if you like).
- **Use-by dates** for mixed vials and pen cartridges.
- **Reminders** — push notifications on shot days (iPhone and Android, from the Home Screen app).
- **Weight** (optional) — weigh-ins, trend chart, projected goal date, milestones, BMI, and how
  much you lost per week on each dose.
- **Progress photos** (optional) — private, kept on your server, with before/after comparison.
- **Email** (optional) — invites, password resets, a weekly summary and a monthly data export.
- **Multiple people** — the first account is the admin; invite others by email or create accounts.
  Everyone's data is private.
- Optional **PostgreSQL** mirror (restore on a fresh install) and a **Grafana** dashboard.

## Install on Proxmox VE

In the **Proxmox VE host shell** (as root):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/fals3illusion/peptidetracker/main/ct/peptidetracker.sh)"
```

It creates an unprivileged Debian 13 container (1 core, 512 MB RAM, 4 GB disk, DHCP — answer "n" to
change any of that), installs the latest release and starts it. Open `http://<container-ip>:3080`
and create your admin account (first-time setup only works from your local network), or choose
**Restore from a PostgreSQL backup** if you're moving from another install.

Everything else is set up in the app, under **⚙ menu → Admin** (a checklist shows what's left):

- **Users** — invite people by email or create accounts with a temporary password.
- **Email** — SMTP for invites, password resets, weekly summaries and exports.
- **Backup & Grafana** — connect a PostgreSQL database (test the connection first), copy-paste SQL to
  create the database and a read-only Grafana user, and download the Grafana dashboard.

## Install on Debian 12/13

Already have a Debian machine or VM? Run this inside it (as root):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/fals3illusion/peptidetracker/main/install/peptidetracker-install.sh)"
```

## Install with Docker

```yaml
# docker-compose.yml
services:
  peptidetracker:
    image: ghcr.io/fals3illusion/peptidetracker:latest
    container_name: peptidetracker
    restart: unless-stopped
    ports:
      - "3080:3080"
    environment:
      - TZ=America/Chicago   # your time zone
    volumes:
      - peptidetracker-data:/data
volumes:
  peptidetracker-data:
```

`docker compose up -d`, then open `http://<host>:3080` and create your admin account. It asks for a one-time
**setup code**, which is in the log: `docker logs peptidetracker` (so nobody else can claim your install first).
**Update:** `docker compose pull && docker compose up -d` (the app shows "Update available" with the
release notes when there's a new version). Images are built for amd64 and arm64 (e.g. Raspberry Pi).
Using a bind mount instead of a volume? Make the folder writable for user 1000: `chown 1000:1000 ./data`.

## Update

As admin, when a new version is out you'll see **“Update vX available”** at the bottom of the app: tap it to
read the release notes and click **Update now** (Proxmox/Debian installs). Docker: `docker compose pull && docker compose up -d`.
Or open the container's console (or SSH in) and type:

```bash
update
```

It checks for a newer release, backs up your data to `/var/backups/peptidetracker/` (last 10
kept), installs it, and puts the old version back automatically if the new one doesn't start.
The admin sees "vX.Y.Z available" in the app's ⚙ menu when there's a new release.
What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## HTTPS, phone app and notifications

Put PeptideTracker behind a reverse proxy with a certificate (Nginx Proxy Manager, Caddy,
Traefik…) pointing at `http://<container-ip>:3080`. HTTPS is needed for:

- **Add to Home Screen** as an app (Safari → Share → Add to Home Screen on iPhone).
- **Shot reminders** — open the app from the Home Screen icon, then Settings → *Shot reminders on
  this phone* → *Turn on for this device* (iOS 16.4+).

No websockets needed. Logins use secure cookies automatically when the proxy sends
`X-Forwarded-Proto: https`.

## Email (optional)

As admin: ⚙ menu → Admin → Email. Gmail works with smtp.gmail.com, port 587, and a Google
[App Password](https://myaccount.google.com/apppasswords). Set "Link to the app" to your HTTPS
address so links in emails work.

## Your data

Everything lives in `/var/lib/peptidetracker/` in the container (`data.json`, `users.json`, and
`photos/`). Passwords are scrypt-hashed and links/sessions are stored only as hashes. Back up the
container with Proxmox's normal backups.

**PostgreSQL backup (optional):** ⚙ menu → Admin → Backup & Grafana. Every change is copied to `pt_*`
tables within seconds; a new install can restore everything from it on the setup screen. Photos
are not copied. (You can also set `PG_URL=postgres://user:password@host:5432/database` in
`/etc/peptidetracker/env` instead; the app then restores from it automatically on an empty data
folder.) The Grafana dashboard is in [`grafana/`](grafana/) and downloadable from the same page. Enter your Grafana address there and everyone gets a **📊 Dashboards** link in the ⚙ menu that opens their own charts (like TeslaMate).

**Forgot the admin password?** In the container:

```bash
cd /opt/peptidetracker && runuser -u peptidetracker -- env DATA_DIR=/var/lib/peptidetracker node set-password.js <username>
```

## Settings on the server

`/etc/peptidetracker/env`: `PORT` (default 3080), `TZ` (used for reminders and summaries),
`PG_URL` (optional), `UPDATE_CHECK=0` to turn off the release check. Logs:
`journalctl -u peptidetracker -e`.

## Development

Node.js 20+, no build step. `npm ci`, `npm start` (http://localhost:3080, data in `./data`),
`npm test`. Database tests run when `PG_TEST_URL` points at a throwaway PostgreSQL.
`scripts/dev-deploy.sh` ships your working copy to your own container over SSH;
`scripts/release.sh X.Y.Z` turns the *Unreleased* changelog section into a release, and GitHub
Actions builds and publishes it.

Built with help from Claude (Anthropic). Not affiliated with Proxmox or the
community-scripts project.

## License

[MIT](LICENSE)
