# Security

PeptideTracker holds personal health data, so security reports are very welcome.

## Reporting a problem

Please **don't open a public issue**. Report it privately instead:
GitHub → this repository → **Security** → **Report a vulnerability**
(https://github.com/fals3illusion/peptidetracker/security/advisories/new).

Include what you found, how to reproduce it, and the version (⚙ menu → About & updates).
You'll get a reply as soon as possible, and fixes ship as a new release that installs update to
with `update` (Proxmox/Debian) or `docker compose pull` (Docker).

## Supported versions

Only the latest release gets fixes. Keep your install up to date — admins see
"Update available" at the bottom of the app.

## Good practice for your install

- Put it behind HTTPS (a reverse proxy) before opening it to the internet.
- Create your admin account right after installing; first-time setup only works from your local network.
- Use a read-only database user for Grafana (the app shows the SQL).
