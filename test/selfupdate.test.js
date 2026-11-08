// The admin's update page: release notes, check now, and the Update now request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';
import { createUpdateCheck } from '../lib/version.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, error() {} };
let server, base, dataDir, unit, tag = 'v99.1.0';
const fakeGitHub = async () => ({ ok: true, json: async () => ({ tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}`, body: '### Added\n- **Big** thing\n- `code` bit', published_at: '2026-11-09T12:00:00Z' }) });
const clients = {};
const call = who => async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(clients[who] && { Cookie: clients[who] }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) clients[who] = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};
const admin = call('admin'), user = call('user');

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-upd-'));
  unit = path.join(dataDir, 'fake-unit.path');
  const updateCheck = createUpdateCheck({ enabled: false, fetcher: fakeGitHub });
  server = http.createServer(createApp({ dataDir, publicDir: path.join(ROOT, 'public'), log: quiet, scheduler: false, updateCheck, selfUpdateUnit: unit }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await admin('POST', '/api/setup', { user: 'alex', password: 'correct horse' });
  await admin('POST', '/api/users', { user: 'kim', password: 'temporary1' });
  await user('POST', '/api/login', { user: 'kim', password: 'temporary1' });
  await user('POST', '/api/password', { current: 'temporary1', password: 'kims own pw' });
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('check now finds a newer release with its notes; only admins see it', async () => {
  assert.equal((await user('GET', '/api/admin/update')).status, 403);
  assert.equal((await admin('GET', '/api/admin/update')).body.available, false, 'not checked yet');
  const d = (await admin('POST', '/api/admin/update/check', {})).body;
  assert.equal(d.available, true);
  assert.equal(d.latest, '99.1.0');
  assert.match(d.notes, /Big/);
  assert.equal((await admin('GET', '/api/data')).body.version.latest, '99.1.0');
  assert.equal((await user('GET', '/api/data')).body.version.latest, undefined, 'non-admins don’t get the update banner');
});

test('Update now only writes a request file for the system updater', async () => {
  assert.equal((await admin('GET', '/api/admin/update')).body.canSelfUpdate, false);
  assert.match((await admin('POST', '/api/admin/update', {})).body.error, /console/);
  fs.writeFileSync(unit, '');
  assert.equal((await user('POST', '/api/admin/update', {})).status, 403);
  assert.equal((await admin('POST', '/api/admin/update', {})).status, 202);
  assert.ok(fs.existsSync(path.join(dataDir, 'update-request')));
  const d = (await admin('GET', '/api/admin/update')).body;
  assert.equal(d.requested, true);
  assert.equal(d.status.state, 'requested');
  // The updater reports back through update-status.json and update.log
  fs.writeFileSync(path.join(dataDir, 'update-status.json'), JSON.stringify({ state: 'failed', message: 'Download failed.', at: Date.now() }));
  fs.writeFileSync(path.join(dataDir, 'update.log'), '\x1b[1m==>\x1b[0m Downloading\nDownload failed.\n');
  const after_ = (await admin('GET', '/api/admin/update')).body;
  assert.equal(after_.status.state, 'failed');
  assert.equal(after_.log.trim(), '==> Downloading\nDownload failed.', 'colour codes removed');
});

test('no Update now when already on the newest version', async () => {
  tag = 'v0.0.1';
  await admin('POST', '/api/admin/update/check', {});
  assert.match((await admin('POST', '/api/admin/update', {})).body.error, /already on the newest/);
});
