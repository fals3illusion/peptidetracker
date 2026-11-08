// Upgrading a real single-user install keeps the login, sessions and data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, error() {} };

test('single-user data becomes the admin profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mig-'));
  const salt = 'abcd';
  const hash = crypto.scryptSync('old password', salt, 64).toString('hex');
  const token = 'tok123';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: 'alex', salt, hash }));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ [tokenHash]: Date.now() + 1e9 }));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    entries: [{ id: 'e1', t: 1, weight: 250, note: '' }],
    supplies: [], shots: [{ id: 's1', t: 2, name: 'T', doseMg: 5, site: 'Abdomen – left' }],
    settings: { goal: 190, unit: 'lb', shotDay: 4 },
  }));

  const server = http.createServer(createApp({ dataDir: dir, publicDir: path.join(ROOT, 'public'), log: quiet }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Already-signed-in phone stays signed in
    const res = await fetch(base + '/api/data', { headers: { Cookie: `pt_session=${token}` } });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.deepEqual(d.entries.map(e => e.weight), [250]);
    assert.equal(d.settings.goal, 190);
    assert.equal(d.settings.shotDay, 4);
    assert.equal(d.settings.showShots, true, 'new settings get defaults');
    assert.equal(d.shots[0].site, 'Stomach – left', 'sites renamed');
    assert.equal(d.me.role, 'admin');
    // Old password still works
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'alex', password: 'old password' }) });
    assert.equal(login.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'auth.json.v1.bak')));
    assert.ok(fs.existsSync(path.join(dir, 'data.json.v1.bak')));
  } finally {
    server.close();
  }

  // Running again changes nothing
  const before = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
  createApp({ dataDir: dir, publicDir: path.join(ROOT, 'public'), log: quiet });
  assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unit-based schedules get the strength of the vial they were used with', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ref-'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'u1', user: 'a', salt: 's', hash: 'h', role: 'admin' }]));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ version: 2, profiles: { u1: {
    entries: [], inventory: [],
    supplies: [{ id: 'v10', name: 'MOTS-C', kind: 'vial', mg: 10, waterMl: 3, opened: 1 }, { id: 'v40', name: 'MOTS-C', kind: 'vial', mg: 40, waterMl: 3, opened: 5 }],
    shots: [{ id: 's1', t: 2, name: 'MOTS-C', doseMg: 0.83, units: 25, supplyId: 'v10' }],
    settings: { protocols: [{ name: 'MOTS-C', freq: 'daily', unit: 'units', amount: 25, titrate: { enabled: false } }] },
  } } }));
  createApp({ dataDir: dir, publicDir: path.join(ROOT, 'public'), log: quiet });
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(d.profiles.u1.settings.protocols[0].refConc, 3.3333, 'from the vial of the last shot, not the newest vial');
  fs.rmSync(dir, { recursive: true, force: true });
});
