// Notifications, weekly summary email, monthly export, and the new settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, error() {} };
const mails = [], pushes = [];
let pushStatus = 0; // set to 410 to simulate a phone that unsubscribed
const fakeTransport = () => ({ sendMail: async m => { mails.push(m); } });
const fakePush = async (sub, payload) => {
  if (pushStatus) { const e = new Error('gone'); e.statusCode = pushStatus; throw e; }
  pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
};
let server, base, dataDir, app, cookie = '';
const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};
const at = (m, d, h, min = 0) => new Date(2026, m - 1, d, h, min).getTime();
const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'BKey', auth: 'secret' } };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-jobs-'));
  app = createApp({ dataDir, publicDir: path.join(ROOT, 'public'), log: quiet, mailTransportFactory: fakeTransport, pushSender: fakePush, scheduler: false });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { user: 'alex', password: 'correct horse' });
  await call('PUT', '/api/mail', { host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: 'x', appUrl: 'https://pt.example.com' });
  await call('PUT', '/api/me', { firstName: 'Alex', email: 'j@example.com', current: 'correct horse' });
  // Weekly Thursday shots, last one Thu Nov 5.
  for (const [m, d] of [[10, 22], [10, 29], [11, 5]]) await call('POST', '/api/shots', { t: at(m, d, 8), name: 'Tirzepatide', doseMg: 10 });
  for (const [m, d, w] of [[10, 22, 222], [10, 29, 219], [11, 5, 216], [11, 10, 215]]) await call('POST', '/api/entries', { t: at(m, d, 6), weight: w });
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('new settings are validated', async () => {
  assert.equal((await call('PUT', '/api/settings', { notify: { enabled: true, time: '25:00' } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { weeklyEmail: { enabled: true, day: 9, time: '18:00' } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { reorderLead: 500 })).status, 400);
  const ok = await call('PUT', '/api/settings', {
    shotDay: 4, notify: { enabled: true, time: '07:30', off: ['MOTS-C'] }, weeklyEmail: { enabled: true, day: 0, time: '18:00' },
    monthlyExport: { enabled: true }, doseChart: true, reorderLead: 14, photos: true,
  });
  assert.equal(ok.status, 200);
  const s = (await call('GET', '/api/data')).body.settings;
  assert.deepEqual(s.notify, { enabled: true, time: '07:30', off: ['mots-c'] });
  assert.equal(s.reorderLead, 14);
  assert.equal(s.doseChart, true);
  assert.equal(s.photos, true);
  assert.ok(s.layout.includes('doseCard'));
});

test('vials keep a use-by (days after mixing)', async () => {
  const v = await call('POST', '/api/supplies', { name: 'Tirzepatide', kind: 'vial', mg: 100, waterMl: 4, opened: at(11, 5, 7), useWithin: 28 });
  assert.equal(v.body.useWithin, 28);
  const bad = await call('POST', '/api/supplies', { name: 'Tirzepatide', kind: 'vial', mg: 100, waterMl: 4, opened: at(11, 5, 7), useWithin: 1000 });
  assert.equal(bad.body.useWithin, null);
});

test('subscribe a device and send a test notification', async () => {
  assert.match((await call('GET', '/api/push/key')).body.key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure' } })).status, 400);
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: sub })).body.devices, 1);
  assert.equal((await call('POST', '/api/push/test', {})).body.sent, 1);
  assert.equal(pushes.length, 1);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'vapid.json'), 'utf8').includes('correct horse'));
});

test('morning notification: only on shot day, after the set time, once', async () => {
  pushes.length = 0;
  await app.tick(at(11, 11, 9));            // Wednesday: nothing due
  assert.equal(pushes.length, 0);
  await app.tick(at(11, 12, 7, 0));         // Thursday 7:00, before 7:30
  assert.equal(pushes.length, 0);
  await app.tick(at(11, 12, 7, 31));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Shot day');
  assert.match(pushes[0].body, /^Tirzepatide: 10 mg/);
  await app.tick(at(11, 12, 7, 32));
  assert.equal(pushes.length, 1, 'only once a day');
});

test('turned off for a medication or logged already: no notification', async () => {
  pushes.length = 0;
  await call('PUT', '/api/settings', { notify: { enabled: true, time: '07:30', off: ['main'] } });
  await app.tick(at(11, 19, 8));
  assert.equal(pushes.length, 0);
  await call('PUT', '/api/settings', { notify: { enabled: true, time: '07:30', off: [] } });
  await call('POST', '/api/shots', { t: at(11, 26, 6), name: 'Tirzepatide', doseMg: 10 });
  await app.tick(at(11, 26, 8));
  assert.equal(pushes.length, 0, 'already logged today');
});

test('a phone that unsubscribed is forgotten', async () => {
  pushStatus = 410;
  assert.equal((await call('POST', '/api/push/test', {})).body.sent, 0);
  pushStatus = 0;
  assert.equal((await call('GET', '/api/push/key')).body.devices, 0);
});

test('weekly summary goes out on the chosen day and time, once', async () => {
  mails.length = 0;
  await app.tick(at(11, 14, 19));           // Saturday
  assert.equal(mails.length, 0);
  await app.tick(at(11, 15, 17, 59));       // Sunday before 6 pm
  assert.equal(mails.length, 0);
  await app.tick(at(11, 15, 18, 5));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'j@example.com');
  assert.match(mails[0].subject, /week/);
  assert.match(mails[0].text, /Hi Alex/);
  assert.match(mails[0].html, /https:\/\/pt\.example\.com/);
  await app.tick(at(11, 15, 18, 6));
  assert.equal(mails.length, 1, 'only once');
});

test('monthly export on the 1st with JSON and CSV attachments', async () => {
  mails.length = 0;
  await call('PUT', '/api/settings', { weeklyEmail: { enabled: false, day: 0, time: '18:00' } });
  await app.tick(at(12, 1, 8));
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].attachments.map(a => a.filename.replace(/\d{4}-\d\d-\d\d/, 'D')),
    ['peptidetracker-alex-D.json', 'peptidetracker-alex-D-weights.csv', 'peptidetracker-alex-D-shots.csv']);
  assert.match(mails[0].attachments[1].content, /^date,weight_lb,note\n/);
  assert.ok(!mails[0].attachments[0].content.includes('"sent"'), 'internal bookkeeping left out');
  await app.tick(at(12, 1, 9));
  assert.equal(mails.length, 1, 'once a month');
});

test('send now buttons', async () => {
  mails.length = 0;
  assert.equal((await call('POST', '/api/summary/send', {})).status, 200);
  assert.equal((await call('POST', '/api/export/send', {})).status, 200);
  assert.equal(mails.length, 2);
});

test('progress photos: private upload, edit, delete', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const up = (body, type = 'image/jpeg', q = '') => fetch(`${base}/api/photos${q}`, { method: 'POST', headers: { 'Content-Type': type, Cookie: cookie }, body });
  await call('PUT', '/api/settings', { photos: false });
  assert.equal((await up(jpeg)).status, 400, 'needs the setting on');
  await call('PUT', '/api/settings', { photos: true });
  assert.equal((await up(jpeg, 'text/plain')).status, 415);
  assert.equal((await up(Buffer.from('not an image'))).status, 400);
  const photo = await (await up(jpeg, 'image/jpeg', `?t=${at(11, 1, 9)}&note=Front`)).json();
  assert.equal(photo.note, 'Front');
  assert.equal(photo.t, at(11, 1, 9));
  const img = await fetch(`${base}/api/photos/${photo.id}/image`, { headers: { Cookie: cookie } });
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/api/photos/${photo.id}/image`)).status, 401, 'login required');
  assert.equal((await call('PUT', `/api/photos/${photo.id}`, { note: 'Side' })).body.note, 'Side');
  assert.equal((await call('GET', '/api/photos')).body.length, 1);
  assert.equal((await call('DELETE', `/api/photos/${photo.id}`)).status, 200);
  assert.equal((await call('GET', '/api/photos')).body.length, 0);
  assert.equal(fs.readdirSync(path.join(dataDir, 'photos')).flatMap(d => fs.readdirSync(path.join(dataDir, 'photos', d))).length, 0);
});

test('reorder planner switch and per-medication lead time', async () => {
  const r = await call('PUT', '/api/settings', { reorderOn: false, medExtras: { 'mots-c': { name: 'MOTS-C', reorderLead: 21 }, bpc: { name: 'BPC', reorderLead: 500 } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.reorderOn, false);
  assert.equal(r.body.medExtras['mots-c'].reorderLead, 21);
  assert.equal(r.body.medExtras.bpc.reorderLead, null, 'out of range is dropped');
  assert.equal((await call('PUT', '/api/settings', { reorderOn: true })).body.reorderOn, true);
});

test('data includes the app version; disclaimer is remembered', async () => {
  const d = (await call('GET', '/api/data')).body;
  assert.match(d.version.current, /^\d+\.\d+\.\d+$/);
  assert.equal(d.sent, undefined, 'internal bookkeeping not sent to the page');
  assert.equal((await call('PUT', '/api/settings', { disclaimerOk: true })).body.disclaimerOk, true);
});

test('download all my data: one JSON file, only my own data', async () => {
  const res = await fetch(base + '/api/export', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="peptidetracker-alex-\d{4}-\d\d-\d\d\.json"/);
  const d = await res.json();
  assert.equal(d.app, 'PeptideTracker');
  assert.equal(d.account.username, 'alex');
  assert.ok(d.entries.length > 0 && d.shots.length > 0);
  assert.equal(d.sent, undefined);
  assert.equal((await fetch(base + '/api/export')).status, 401, 'login required');
});
