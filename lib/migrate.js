// One-time upgrade from the single-user layout (auth.json + flat data.json)
// to multiple users (users.json + data.json with a profile per user).
// Safe to run on every start: it does nothing once the data is upgraded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SITE_RENAMES = { 'Abdomen – left': 'Stomach – left', 'Abdomen – right': 'Stomach – right' };

export function renameSites(shots) {
  for (const s of shots || []) if (s.site && SITE_RENAMES[s.site]) s.site = SITE_RENAMES[s.site];
}

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJson(f, data) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export function migrateDataDir(dataDir, log = console) {
  const authFile = path.join(dataDir, 'auth.json');
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const dataFile = path.join(dataDir, 'data.json');

  // 1. Single login -> first admin user.
  if (fs.existsSync(authFile) && !fs.existsSync(usersFile)) {
    const acc = readJson(authFile);
    const admin = { id: crypto.randomUUID(), user: acc.user, salt: acc.salt, hash: acc.hash, role: 'admin', mustChange: false, created: Date.now() };
    writeJson(usersFile, [admin]);
    fs.renameSync(authFile, `${authFile}.v1.bak`);
    log.log(`[migrate] Login "${acc.user}" is now the admin user`);
  }
  const users = fs.existsSync(usersFile) ? readJson(usersFile) : [];
  const admin = users.find(u => u.role === 'admin');

  // 2. Old sessions were just an expiry time; they belonged to the only user.
  if (admin && fs.existsSync(sessionsFile)) {
    const s = readJson(sessionsFile);
    let changed = false;
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number') { s[k] = { exp: v, userId: admin.id }; changed = true; }
    }
    if (changed) writeJson(sessionsFile, s);
  }

  // 3. Flat data -> the admin's profile (or held until the first account is created).
  if (fs.existsSync(dataFile)) {
    const d = readJson(dataFile);
    if (d.version !== 2) {
      fs.copyFileSync(dataFile, `${dataFile}.v1.bak`);
      const { entries = [], supplies = [], shots = [], settings = {} } = d;
      renameSites(shots);
      const owner = admin ? admin.id : '__unclaimed';
      writeJson(dataFile, { version: 2, profiles: { [owner]: { entries, supplies, shots, settings } } });
      log.log(`[migrate] Moved ${entries.length} weigh-ins and ${shots.length} shots to ${admin ? `"${admin.user}"` : 'the first account'}`);
    }
  }
}
