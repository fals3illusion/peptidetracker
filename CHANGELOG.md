# Changelog

All notable changes to PeptideTracker. Run `update` in the container to get the latest.

## [Unreleased]

## [1.0.0] - 2026-11-08

### First public release
- Shots and vials: mg or syringe units, what's left in each vial, cost per shot, split doses
  across two vials, correct what's left.
- Main GLP-1 with shot day and step-up dose plan; other peptides on their own schedules.
- Next shots card with one-tap ✓ Log and Undo.
- Per-medication injection-site rotation with custom sites.
- Medications page and Inventory (powder vials, bacteriostatic water, supplies, lots, expiry, low stock).
- Reorder planner with per-medication order-ahead days (can be turned off).
- Use-by dates for mixed vials and pen cartridges.
- Shot-day push notifications.
- Optional weight tracking: trend chart, projected goal date, milestones, BMI, results per dose.
- Optional progress photos, weekly summary email and monthly data export email.
- Multiple users with email invites and password resets; optional PostgreSQL mirror and Grafana dashboard.
- Proxmox VE installer, `update` command with automatic backup and rollback, "update available" notice for the admin.
- One-time disclaimer for each person.
- Admin → Backup & Grafana: connect a PostgreSQL backup from the app (with a connection test), copy-paste setup SQL, and download the Grafana dashboard.
- Restore a new install from a PostgreSQL backup on the setup screen.
- Admin setup checklist.
- Updates from the app: the admin sees “Update vX available” at the bottom of the page, opens the release
  notes, and clicks Update now (backup first, automatic rollback). Checks GitHub twice a day, or on demand.
- Installer tested on Proxmox VE: picks the Debian template for your CPU and cleans up if setup fails.
- Invite links you can text or email: one-time sign-up link with Copy and Share buttons; or a username +
  temporary password with a ready-to-text sign-in message.
