// Admin → Backup & Grafana, and first-time restore from a backup.
// Needs a throwaway PostgreSQL: PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
// (creates and drops databases named pt_bk_*). Skipped when PG_TEST_URL is not set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';

const url = process.env.PG_TEST_URL;
const opts = { skip: !url && 'PG_TEST_URL not set', concurrency: false };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, error() {} };
const servers = [];

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bk-'));
  const app = createApp({ dataDir, publicDir: path.join(ROOT, 'public'), log: quiet, scheduler: false });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push({ server, dataDir });
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
      method, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, dataDir };
}

let db; // connection details for the test databases
before(async () => {
  if (!url) return;
  const u = new URL(url);
  db = { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const n of ['pt_bk_a', 'pt_bk_b']) { await admin.query(`DROP DATABASE IF EXISTS ${n}`); await admin.query(`CREATE DATABASE ${n}`); }
  await admin.end();
});
after(async () => { for (const s of servers) { s.server.close(); fs.rmSync(s.dataDir, { recursive: true, force: true }); } });

test('turn on the backup from the Admin page, then restore a new install from it', opts, async () => {
  const a = await startApp();
  await a.call('POST', '/api/setup', { user: 'alex', password: 'correct horse' });
  await a.call('POST', '/api/entries', { t: Date.now(), weight: 200 });
  await a.call('POST', '/api/shots', { t: Date.now(), name: 'Tirzepatide', doseMg: 5 });
  assert.deepEqual((await a.call('GET', '/api/admin/backup')).body, { mode: null, envManaged: false, enabled: false });

  const bad = await a.call('POST', '/api/admin/backup/test', { ...db, database: 'pt_bk_a', password: 'wrong' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Wrong database username or password/);
  assert.match((await a.call('POST', '/api/admin/backup/test', { ...db, database: 'nope_db' })).body.error, /doesn’t exist/);
  assert.deepEqual((await a.call('POST', '/api/admin/backup/test', { ...db, database: 'pt_bk_a' })).body, { ok: true, existing: null });

  const on = await a.call('PUT', '/api/admin/backup', { ...db, database: 'pt_bk_a' });
  assert.equal(on.status, 200);
  assert.equal(on.body.mode, 'app');
  assert.equal(on.body.hasPassword, true);
  assert.equal(on.body.password, undefined, 'password never sent back');
  assert.ok(on.body.lastOk, 'copied right away');
  assert.equal(fs.statSync(path.join(a.dataDir, 'db.json')).mode & 0o777, 0o600);
  assert.equal((await a.call('GET', '/api/data')).body.sync.enabled, true);

  // Pointing a second install at the same database needs a confirmation (it would replace that backup).
  const b = await startApp();
  await b.call('POST', '/api/setup', { user: 'sam', password: 'correct horse' });
  const clash = await b.call('PUT', '/api/admin/backup', { ...db, database: 'pt_bk_a' });
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.body.existing, { users: 1, entries: 1, shots: 1 });

  // A brand-new install restores from it on the setup screen.
  const c = await startApp();
  assert.equal((await c.call('POST', '/api/setup/restore', { ...db, database: 'pt_bk_b' })).body.error, 'No PeptideTracker backup found in that database');
  const r = await c.call('POST', '/api/setup/restore', { ...db, database: 'pt_bk_a' });
  assert.deepEqual(r.body, { users: 1, entries: 1, shots: 1 });
  assert.equal((await c.call('POST', '/api/setup/restore', { ...db, database: 'pt_bk_a' })).status, 403, 'only before any account exists');
  assert.equal((await c.call('POST', '/api/login', { user: 'alex', password: 'correct horse' })).status, 200, 'same login as before');
  const data = (await c.call('GET', '/api/data')).body;
  assert.equal(data.entries[0].weight, 200);
  assert.equal(data.sync.enabled, true, 'keeps backing up to the same database');

  const off = await a.call('DELETE', '/api/admin/backup');
  assert.equal(off.body.enabled, false);
  assert.equal(fs.existsSync(path.join(a.dataDir, 'db.json')), false);
});

test('only the admin can see or change the backup', opts, async () => {
  const a = await startApp();
  await a.call('POST', '/api/setup', { user: 'alex', password: 'correct horse' });
  await a.call('POST', '/api/users', { user: 'kim', password: 'temporary1' });
  await a.call('POST', '/api/logout', {});
  await a.call('POST', '/api/login', { user: 'kim', password: 'temporary1' });
  await a.call('POST', '/api/password', { current: 'temporary1', password: 'kims own pw' });
  assert.equal((await a.call('GET', '/api/admin/backup')).status, 403);
  assert.equal((await a.call('PUT', '/api/admin/backup', { ...db, database: 'pt_bk_b' })).status, 403);
});
