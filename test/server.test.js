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
let server, base, dataDir;
// Fake SMTP: records messages instead of sending; can be told to fail.
const sent = [];
let smtpFails = false;
const fakeTransport = opts => ({ sendMail: async m => { if (smtpFails) throw new Error('Invalid login: 535 5.7.8 Username and Password not accepted'); sent.push({ ...m, opts }); } });

// A tiny client that remembers its own session cookie (one per person).
function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
}
const admin = client(), wife = client(), stranger = client(), kim = client();

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  server = http.createServer(createApp({ dataDir, publicDir: path.join(ROOT, 'public'), log: quiet, mailTransportFactory: fakeTransport }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('data is locked before setup; page still loads', async () => {
  assert.equal((await stranger('GET', '/api/data')).status, 401);
  assert.equal((await stranger('GET', '/api/auth')).body.setupNeeded, true);
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('setup is refused through the reverse proxy', async () => {
  const r = await stranger('POST', '/api/setup', { user: 'evil', password: 'password123' }, { 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(r.status, 403);
});

test('setup creates the admin once', async () => {
  assert.equal((await admin('POST', '/api/setup', { user: 'me', password: 'short' })).status, 400);
  const ok = await admin('POST', '/api/setup', { user: 'alex', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);
  assert.equal((await stranger('POST', '/api/setup', { user: 'evil', password: 'password123' })).status, 403);
  const me = (await admin('GET', '/api/auth')).body;
  assert.deepEqual([me.user, me.role, me.mustChange], ['alex', 'admin', false]);
});

test('password file does not contain the password', () => {
  const raw = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  assert.ok(!raw.includes('correct horse'));
});

test('secure cookie behind https proxy', async () => {
  const r = await stranger('POST', '/api/login', { user: 'alex', password: 'correct horse' }, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '10.0.0.9' });
  assert.match(r.setCookie, /Secure/);
  await stranger('POST', '/api/logout', {});
});

test('non-JSON writes are rejected (CSRF guard)', async () => {
  const res = await fetch(base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"t":1,"weight":200}' });
  assert.ok([401, 415].includes(res.status));
});

test('entries: add, edit, sorted by date, delete', async () => {
  const a = (await admin('POST', '/api/entries', { t: 2000, weight: 240, note: 'b' })).body;
  const b = (await admin('POST', '/api/entries', { t: 1000, weight: 250, note: 'a' })).body;
  let data = (await admin('GET', '/api/data')).body;
  assert.deepEqual(data.entries.map(e => e.weight), [250, 240]);
  assert.equal((await admin('PUT', `/api/entries/${b.id}`, { t: 3000, weight: 238.5, note: 'edited' })).status, 200);
  data = (await admin('GET', '/api/data')).body;
  assert.deepEqual(data.entries.map(e => [e.weight, e.note]), [[240, 'b'], [238.5, 'edited']]);
  assert.equal((await admin('PUT', `/api/entries/${a.id}`, { t: 2000, weight: 5 })).status, 400);
  assert.equal((await admin('PUT', '/api/entries/nope', { t: 2000, weight: 200 })).status, 404);
  assert.equal((await admin('DELETE', `/api/entries/${a.id}`)).status, 200);
  assert.equal((await admin('GET', '/api/data')).body.entries.length, 1);
});

test('supplies and shots: add, edit, validate, unlink on delete', async () => {
  const v = await admin('POST', '/api/supplies', { name: 'Tirzepatide', kind: 'vial', mg: 60, waterMl: 3, price: 200, opened: 5000, count: 9 });
  assert.equal(v.status, 201);
  assert.equal(v.body.count, null);
  assert.equal((await admin('POST', '/api/supplies', { name: 'X', kind: 'jar', opened: 1 })).status, 400);
  const shot = await admin('POST', '/api/shots', { t: 6000, supplyId: v.body.id, name: 'Tirzepatide', doseMg: 7.5, units: 37.5, site: 'Stomach – left' });
  assert.equal(shot.status, 201);
  assert.equal(shot.body.site, 'Stomach – left');
  assert.equal((await admin('POST', '/api/shots', { t: 6000, supplyId: 'nope', name: 'T', doseMg: 5 })).status, 400);
  await admin('DELETE', `/api/supplies/${v.body.id}`);
  const data = (await admin('GET', '/api/data')).body;
  assert.equal(data.shots[0].supplyId, null);
  assert.deepEqual(data.sync, { enabled: false });
  assert.equal(data.me.user, 'alex');
});

test('settings: shot day, refill, height, site rotation, hide shots', async () => {
  const ok = await admin('PUT', '/api/settings', { shotDay: 4, refillAt: 2, heightIn: 70, sites: ['Stomach – right', 'Stomach – left'] });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.shotDay, ok.body.refillAt, ok.body.heightIn], [4, 2, 70]);
  assert.deepEqual(ok.body.sites, ['Stomach – left', 'Stomach – right'], 'kept in rotation order');
  assert.equal(ok.body.showShots, true);
  assert.equal((await admin('PUT', '/api/settings', { sites: [] })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { sites: ['Elbow'] })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { shotDay: 7 })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { showShots: false })).body.showShots, false);
  const plan = await admin('PUT', '/api/settings', { plan: { enabled: true, start: 1000, startDose: 2.5, step: 2.5, every: 4, maxDose: 12.5 } });
  assert.deepEqual(plan.body.plan, { enabled: true, start: 1000, startDose: 2.5, step: 2.5, every: 4, maxDose: 12.5 });
  assert.equal((await admin('PUT', '/api/settings', { plan: { maxDose: 1 } })).status, 400, 'max below starting dose');
  assert.equal((await admin('PUT', '/api/settings', { plan: { every: 0 } })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { plan: { step: -2 } })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { goal: 180 })).body.plan.maxDose, 12.5, 'other settings keep the plan');
  const bpc = { name: 'BPC-157', freq: 'days', days: [5, 1, 1, 9], unit: 'units', amount: 10, start: 1000, titrate: { enabled: true, step: 2, every: 7, max: 20 } };
  const pr = await admin('PUT', '/api/settings', { protocols: [bpc] });
  assert.equal(pr.status, 200);
  assert.deepEqual(pr.body.protocols[0].days, [1, 5], 'days de-duplicated, sorted, invalid dropped');
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, freq: 'days', days: [] }] })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, unit: 'ml' }] })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, amount: 0 }] })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, titrate: { enabled: true, step: 2, every: 7, max: 5 } }] })).status, 400, 'max below dose');
  assert.equal((await admin('PUT', '/api/settings', { protocols: [bpc, { ...bpc, name: 'bpc-157' }] })).status, 400, 'duplicate name');
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, freq: 'every', everyN: 3 }] })).body.protocols[0].everyN, 3);
  assert.equal((await admin('PUT', '/api/settings', { goal: 180 })).body.protocols.length, 1, 'kept when saving other settings');
  const rc = await admin('PUT', '/api/settings', { protocols: [{ ...bpc, refConc: 2.5 }] });
  assert.equal(rc.body.protocols[0].refConc, 2.5);
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, unit: 'mg', refConc: 2.5 }] })).body.protocols[0].refConc, null, 'only for unit schedules');
  assert.equal((await admin('PUT', '/api/settings', { protocols: [{ ...bpc, refConc: -1 }] })).status, 400);
  // Custom sites and per-medication settings
  const cs = await admin('PUT', '/api/settings', { customSites: ['Love handle – left', 'Stomach – left', ' ', 'Love handle – LEFT', 'Glute <b>'] });
  assert.deepEqual(cs.body.customSites, ['Love handle – left', 'Glute b'], 'built-ins and duplicates dropped, tags stripped');
  const mx = await admin('PUT', '/api/settings', { sites: ['Stomach – left', 'Love handle – left'], medExtras: { 'bpc-157': { name: 'BPC-157', kind: 'own', sites: ['Love handle – left', 'Thigh – left'], vialMg: 5, waterMl: 2, price: 40 } } });
  assert.equal(mx.status, 200);
  assert.deepEqual(mx.body.sites, ['Stomach – left', 'Love handle – left']);
  assert.deepEqual(mx.body.medExtras['bpc-157'].sites, ['Thigh – left', 'Love handle – left'], 'kept in site order');
  assert.equal(mx.body.medExtras['bpc-157'].vialMg, 5);
  assert.equal((await admin('PUT', '/api/settings', { medExtras: { x: { name: 'X', sites: ['Elbow'] } } })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { medExtras: { x: { name: 'X', price: -5 } } })).status, 400);
  // Removing a custom site removes it from rotations
  const rm = await admin('PUT', '/api/settings', { customSites: ['Glute b'] });
  assert.deepEqual(rm.body.sites, ['Stomach – left']);
  assert.deepEqual(rm.body.medExtras['bpc-157'].sites, ['Thigh – left']);
  // Weight tracking, banners, section order
  const lay = await admin('PUT', '/api/settings', { trackWeight: false, banners: { enabled: true, off: ['MOTS-C', 'main', 'mots-c'] }, layout: ['shotCard', 'nextCard', 'bogus', 'shotCard'] });
  assert.equal(lay.body.trackWeight, false);
  assert.deepEqual(lay.body.banners, { enabled: true, off: ['mots-c', 'main'] });
  assert.deepEqual(lay.body.layout.slice(0, 3), ['shotCard', 'nextCard', 'logCard'], 'unknown/duplicates dropped, rest appended');
  assert.equal(lay.body.layout.length, 10);
  assert.equal((await admin('PUT', '/api/settings', { layout: 'x' })).status, 400);
  await admin('PUT', '/api/settings', { trackWeight: true });
  await admin('PUT', '/api/settings', { showShots: true });
});

test('inventory: add items, auto numbers, validation', async () => {
  const pep = await admin('POST', '/api/inventory', { kind: 'peptide', name: 'BPC-157', mg: 5, qty: 3, price: 40, lot: 'A12', lowAt: 1 });
  assert.equal(pep.status, 201);
  assert.equal(pep.body.code, '#001');
  const water = await admin('POST', '/api/inventory', { kind: 'water', name: 'Bac water', bottleMl: 30, qty: 2, openMl: 2 });
  assert.equal(water.body.code, '#002');
  const syr = await admin('POST', '/api/inventory', { kind: 'other', name: 'Syringes', unit: 'syringes', qty: 10, perShot: true, code: 'SYR-1' });
  assert.equal(syr.body.code, 'SYR-1', 'own number kept');
  assert.equal((await admin('POST', '/api/inventory', { kind: 'jar', name: 'x' })).status, 400);
  assert.equal((await admin('POST', '/api/inventory', { kind: 'peptide', name: '' })).status, 400);
  assert.equal((await admin('POST', '/api/inventory', { kind: 'other', name: 'x', qty: 1.5 })).status, 400);
});

test('mixing a vial from inventory takes stock; water spans bottles; shots use syringes', async () => {
  const inv = (await admin('GET', '/api/data')).body.inventory;
  const pep = inv.find(x => x.kind === 'peptide'), water = inv.find(x => x.kind === 'water'), syr = inv.find(x => x.kind === 'other');
  // 3 mL: 2 mL left in the open bottle + 1 mL from a new 30 mL bottle
  const v = await admin('POST', '/api/supplies', { name: 'BPC-157', kind: 'vial', mg: 5, waterMl: 3, price: 40, opened: 5000, fromInventory: pep.id, waterFrom: water.id });
  assert.equal(v.status, 201);
  assert.equal(v.body.invCode, '#001');
  assert.equal(v.body.lot, 'A12');
  let after = (await admin('GET', '/api/data')).body.inventory;
  assert.equal(after.find(x => x.id === pep.id).qty, 2);
  const w = after.find(x => x.id === water.id);
  assert.deepEqual([w.qty, w.openMl], [1, 29]);
  // Editing the vial keeps where it came from
  const ed = await admin('PUT', `/api/supplies/${v.body.id}`, { name: 'BPC-157', kind: 'vial', mg: 5, waterMl: 3, price: 40, opened: 5000 });
  assert.equal(ed.body.invCode, '#001');
  // Logging a shot uses one syringe; editing a shot doesn't
  const shot = await admin('POST', '/api/shots', { t: 9000, supplyId: v.body.id, name: 'BPC-157', doseMg: 0.25, units: 15 });
  await admin('PUT', `/api/shots/${shot.body.id}`, { t: 9000, supplyId: v.body.id, name: 'BPC-157', doseMg: 0.25, units: 15 });
  after = (await admin('GET', '/api/data')).body.inventory;
  assert.equal(after.find(x => x.id === syr.id).qty, 9);
  // A split dose (two parts, same groupId) uses one syringe
  const p1 = await admin('POST', '/api/shots', { t: 9500, supplyId: v.body.id, name: 'BPC-157', doseMg: 0.2, groupId: 'grp-1' });
  assert.equal(p1.body.groupId, 'grp-1');
  await admin('POST', '/api/shots', { t: 9500, name: 'BPC-157', doseMg: 0.05, groupId: 'grp-1' });
  assert.equal((await admin('POST', '/api/shots', { t: 9500, name: 'X', doseMg: 1, groupId: 'bad id!' })).body.groupId, null);
  after = (await admin('GET', '/api/data')).body.inventory;
  assert.equal(after.find(x => x.id === syr.id).qty, 7, 'one for the split dose, one for shot X');
  // Not enough water -> still saves, with a note
  const big = await admin('POST', '/api/supplies', { name: 'BPC-157', kind: 'vial', mg: 5, waterMl: 99, opened: 6000, waterFrom: water.id });
  assert.equal(big.status, 201);
  assert.match(big.body.stockNotes[0], /Not enough/);
  // Adjust stock by editing the item
  const up = await admin('PUT', `/api/inventory/${pep.id}`, { ...after.find(x => x.id === pep.id), qty: 7 });
  assert.equal(up.body.qty, 7);
  assert.equal(up.body.code, '#001');
  // Other users don't see it
  assert.equal((await wife('GET', '/api/data')).body?.inventory?.length ?? 0, 0);
});

// ---- multiple users ----
let wifeId;
test('only the admin can add users', async () => {
  assert.equal((await stranger('POST', '/api/users', { user: 'x', password: 'password123' })).status, 401);
  const r = await admin('POST', '/api/users', { user: 'sarah', password: 'temporary1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.mustChange, true);
  assert.equal(r.body.salt, undefined, 'no secrets in responses');
  assert.equal(r.body.hash, undefined);
  wifeId = r.body.id;
  assert.equal((await admin('POST', '/api/users', { user: 'SARAH', password: 'temporary1' })).status, 400, 'names are unique, any case');
  assert.equal((await admin('POST', '/api/users', { user: 'bob', password: 'short' })).status, 400);
  const list = (await admin('GET', '/api/users')).body;
  assert.deepEqual(list.map(u => u.user), ['alex', 'sarah']);
  assert.ok(list.every(u => !('hash' in u)));
});

test('new user must change the temporary password before anything else', async () => {
  const login = await wife('POST', '/api/login', { user: 'sarah', password: 'temporary1' });
  assert.equal(login.status, 200);
  assert.equal(login.body.mustChange, true);
  const blocked = await wife('GET', '/api/data');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.mustChange, true);
  assert.equal((await wife('POST', '/api/password', { password: 'temporary1' })).status, 400, 'must differ from the temporary one');
  assert.equal((await wife('POST', '/api/password', { password: 'sarahs own pw' })).status, 200);
  assert.equal((await wife('GET', '/api/auth')).body.mustChange, false);
  assert.equal((await wife('GET', '/api/data')).status, 200, 'same session keeps working');
  // Old temporary password no longer works
  assert.equal((await stranger('POST', '/api/login', { user: 'sarah', password: 'temporary1' })).status, 401);
});

test("each user's data is private", async () => {
  await wife('POST', '/api/entries', { t: 9000, weight: 160 });
  await wife('PUT', '/api/settings', { goal: 140, showShots: false });
  const mine = (await admin('GET', '/api/data')).body;
  const hers = (await wife('GET', '/api/data')).body;
  assert.deepEqual(hers.entries.map(e => e.weight), [160]);
  assert.ok(!mine.entries.some(e => e.weight === 160));
  assert.equal(hers.settings.goal, 140);
  assert.notEqual(mine.settings.goal, 140);
  assert.equal(hers.shots.length, 0);
  // She can't touch his records by id
  const hisEntry = mine.entries[0];
  assert.equal((await wife('DELETE', `/api/entries/${hisEntry.id}`)).status, 404);
  assert.equal((await wife('PUT', `/api/entries/${hisEntry.id}`, { t: 1, weight: 100 })).status, 404);
  // And she can't manage users
  assert.equal((await wife('GET', '/api/users')).status, 403);
  assert.equal((await wife('POST', '/api/users', { user: 'x', password: 'password123' })).status, 403);
});

// ---- email ----
test('email settings: admin only, password never returned, blank keeps it', async () => {
  assert.equal((await wife('GET', '/api/mail')).status, 403);
  assert.deepEqual((await admin('GET', '/api/mail')).body, { configured: false });
  assert.equal((await admin('PUT', '/api/mail', { host: 'smtp.gmail.com', port: 99999, user: 'me@gmail.com' })).status, 400);
  assert.equal((await admin('PUT', '/api/mail', { host: 'bad host!', port: 587, user: 'me@gmail.com' })).status, 400);
  const ok = await admin('PUT', '/api/mail', { host: 'smtp.gmail.com', port: 587, secure: false, user: 'me@gmail.com', pass: 'abcd efgh ijkl mnop', appUrl: 'https://wt.example.com/' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pass, undefined);
  assert.equal(ok.body.hasPassword, true);
  assert.equal(ok.body.fromAddress, 'me@gmail.com', 'from defaults to the login');
  assert.equal(ok.body.appUrl, 'https://wt.example.com', 'trailing slash trimmed');
  // Saving again without a password keeps the old one
  const again = await admin('PUT', '/api/mail', { host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: '' });
  assert.equal(again.body.hasPassword, true);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'mail.json'), 'utf8'));
  assert.equal(stored.pass, 'abcdefghijklmnop', 'spaces from Google’s app password display removed');
  assert.equal((await admin('GET', '/api/data')).body.mailReady, true);
});

test('test email goes out with TLS required', async () => {
  const r = await admin('POST', '/api/mail/test', { to: 'me@gmail.com' });
  assert.equal(r.status, 200);
  const m = sent.at(-1);
  assert.equal(m.to, 'me@gmail.com');
  assert.equal(m.opts.requireTLS, true);
  assert.deepEqual(m.opts.auth, { user: 'me@gmail.com', pass: 'abcdefghijklmnop' });
  assert.equal((await admin('POST', '/api/mail/test', { to: 'not-an-email' })).status, 400);
});

test('adding a user with an email sends the invite', async () => {
  const r = await admin('POST', '/api/users', { user: 'mom', password: 'temp-pass-9', email: 'mom@example.com', sendInvite: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.emailed, true);
  assert.equal(r.body.email, 'mom@example.com');
  const m = sent.at(-1);
  assert.equal(m.to, 'mom@example.com');
  assert.match(m.text, /Username: mom/);
  assert.match(m.text, /Temporary password: temp-pass-9/);
  assert.match(m.text, /https:\/\/wt\.example\.com\/\?u=mom/);
  assert.match(m.html, /temp-pass-9/);
  assert.equal(m.from.address, 'me@gmail.com');
  assert.equal((await admin('POST', '/api/users', { user: 'x2', password: 'temp-pass-9', email: 'nope' })).status, 400);
});

test('email failure still creates the user and explains why', async () => {
  smtpFails = true;
  const r = await admin('POST', '/api/users', { user: 'dad', password: 'temp-pass-8', email: 'dad@example.com', sendInvite: true });
  smtpFails = false;
  assert.equal(r.status, 201);
  assert.equal(r.body.emailed, false);
  assert.match(r.body.emailError, /App Password/);
  assert.ok((await admin('GET', '/api/users')).body.some(u => u.user === 'dad'));
});

test('reset password can email the new temporary password; email can be edited', async () => {
  const mom = (await admin('GET', '/api/users')).body.find(u => u.user === 'mom');
  const r = await admin('POST', `/api/users/${mom.id}/password`, { password: 'new-temp-77', sendEmail: true });
  assert.equal(r.body.emailed, true);
  assert.match(sent.at(-1).subject, /reset/i);
  assert.match(sent.at(-1).text, /new-temp-77/);
  const e = await admin('PUT', `/api/users/${mom.id}`, { email: 'mom2@example.com' });
  assert.equal(e.body.email, 'mom2@example.com');
  assert.equal((await admin('PUT', `/api/users/${mom.id}`, { email: 'bad' })).status, 400);
  assert.equal((await wife('PUT', `/api/users/${mom.id}`, { email: 'x@y.com' })).status, 403);
});

// ---- email invites, sign in by email, forgot password, my account ----
const tick = () => new Promise(r => setTimeout(r, 50));
const tokenIn = (msg, key) => new URL(msg.text.match(/https?:\/\/\S+/g).find(u => u.includes(`${key}=`))).searchParams.get(key);
let inviteToken;

test('admin invites by email only; link carries a one-time token', async () => {
  assert.equal((await wife('POST', '/api/invites', { email: 'kim@example.com' })).status, 403);
  assert.equal((await admin('POST', '/api/invites', { email: 'nope' })).status, 400);
  assert.equal((await admin('POST', '/api/invites', { email: 'MOM2@example.com' })).status, 400, 'already a user (any case)');
  const r = await admin('POST', '/api/invites', { email: 'kim@example.com' });
  assert.equal(r.status, 201);
  assert.equal(r.body.tokenHash, undefined);
  const m = sent.at(-1);
  assert.equal(m.to, 'kim@example.com');
  assert.match(m.subject, /invited you/);
  inviteToken = tokenIn(m, 'invite');
  assert.ok(inviteToken.length > 30);
  assert.match(m.text, /https:\/\/wt\.example\.com\/\?invite=/);
  const list = (await admin('GET', '/api/invites')).body;
  assert.deepEqual(list.map(i => i.email), ['kim@example.com']);
  assert.ok(!JSON.stringify(list).includes(inviteToken), 'token never listed');
});

test('accepting the invite: pick username, name, password', async () => {
  assert.equal((await kim('GET', '/api/invite/not-a-real-token')).status, 404);
  assert.deepEqual((await kim('GET', `/api/invite/${inviteToken}`)).body, { email: 'kim@example.com' });
  assert.equal((await kim('POST', `/api/invite/${inviteToken}`, { user: 'kimmy', password: 'kims-password', firstName: '' })).status, 400, 'first name required');
  assert.equal((await kim('POST', `/api/invite/${inviteToken}`, { user: 'alex', password: 'kims-password', firstName: 'Kim' })).status, 400, 'username taken');
  const ok = await kim('POST', `/api/invite/${inviteToken}`, { user: 'kimmy', password: 'kims-password', firstName: 'Kim', lastName: 'Lee' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mustChange, false);
  const me = (await kim('GET', '/api/auth')).body;
  assert.deepEqual([me.user, me.firstName, me.mustChange], ['kimmy', 'Kim', false]);
  assert.equal((await kim('GET', '/api/data')).status, 200);
  assert.equal((await stranger('GET', `/api/invite/${inviteToken}`)).status, 404, 'link works once');
  const row = (await admin('GET', '/api/users')).body.find(u => u.user === 'kimmy');
  assert.deepEqual([row.email, row.firstName, row.lastName, row.mustChange], ['kim@example.com', 'Kim', 'Lee', false]);
  assert.deepEqual((await admin('GET', '/api/invites')).body, []);
});

test('resend replaces the link; cancel removes the invite', async () => {
  await admin('POST', '/api/invites', { email: 'pat@example.com' });
  const first = tokenIn(sent.at(-1), 'invite');
  const inv = (await admin('GET', '/api/invites')).body[0];
  assert.equal((await admin('POST', `/api/invites/${inv.id}/resend`, {})).status, 200);
  const second = tokenIn(sent.at(-1), 'invite');
  assert.notEqual(first, second);
  assert.equal((await stranger('GET', `/api/invite/${first}`)).status, 404, 'old link dead');
  assert.equal((await stranger('GET', `/api/invite/${second}`)).status, 200);
  await admin('DELETE', `/api/invites/${inv.id}`, undefined);
  assert.equal((await stranger('GET', `/api/invite/${second}`)).status, 404);
});

test('sign in with email address (any case)', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/login', { user: 'KIM@example.com', password: 'kims-password' })).status, 200);
  assert.equal((await c('GET', '/api/auth')).body.user, 'kimmy');
  assert.equal((await client()('POST', '/api/login', { user: 'kim@example.com', password: 'wrong-pass' })).status, 401);
});

test('forgot password: same reply for unknown accounts; one-time reset link', async () => {
  const before = sent.length;
  const unknown = await stranger('POST', '/api/forgot', { login: 'nobody' }, { 'X-Forwarded-For': '10.5.5.1' });
  await tick();
  assert.equal(unknown.status, 200);
  assert.equal(sent.length, before, 'nothing sent for unknown users');
  const r = await stranger('POST', '/api/forgot', { login: 'kimmy' }, { 'X-Forwarded-For': '10.5.5.1' });
  await tick();
  assert.deepEqual(r.body, unknown.body, 'identical response');
  const m = sent.at(-1);
  assert.equal(m.to, 'kim@example.com');
  const token = tokenIn(m, 'reset');
  assert.equal((await stranger('GET', `/api/reset/${token}`)).body.user, 'kimmy');
  assert.equal((await stranger('POST', `/api/reset/${token}`, { password: 'short' })).status, 400);
  const c = client();
  assert.equal((await c('POST', `/api/reset/${token}`, { password: 'kims-new-password' })).status, 200);
  assert.equal((await c('GET', '/api/data')).status, 200, 'signed in after reset');
  assert.equal((await kim('GET', '/api/data')).status, 401, 'other sessions signed out');
  assert.equal((await stranger('GET', `/api/reset/${token}`)).status, 404, 'link works once');
  assert.equal((await client()('POST', '/api/login', { user: 'kimmy', password: 'kims-password' })).status, 401);
  assert.equal((await kim('POST', '/api/login', { user: 'kimmy', password: 'kims-new-password' })).status, 200);
});

test('forgot password is rate limited', async () => {
  const h = { 'X-Forwarded-For': '10.6.6.6' };
  for (let i = 0; i < 10; i++) await stranger('POST', '/api/forgot', { login: 'nobody' }, h);
  assert.equal((await stranger('POST', '/api/forgot', { login: 'kimmy' }, h)).status, 429);
});

test('my account: change name freely; email needs current password', async () => {
  const n = await kim('PUT', '/api/me', { firstName: 'Kimberly', lastName: 'Lee', email: 'kim@example.com' });
  assert.equal(n.status, 200);
  assert.equal(n.body.firstName, 'Kimberly');
  assert.equal((await kim('PUT', '/api/me', { firstName: 'Kimberly', lastName: 'Lee', email: 'kim2@example.com' })).status, 400);
  assert.equal((await kim('PUT', '/api/me', { firstName: 'Kimberly', lastName: 'Lee', email: 'kim2@example.com', current: 'wrong' })).status, 400);
  assert.equal((await kim('PUT', '/api/me', { firstName: 'Kimberly', lastName: 'Lee', email: 'mom2@example.com', current: 'kims-new-password' })).status, 400, 'taken');
  const ok = await kim('PUT', '/api/me', { firstName: 'Kimberly', lastName: 'Lee', email: 'kim2@example.com', current: 'kims-new-password' });
  assert.equal(ok.body.email, 'kim2@example.com');
  const row = (await admin('GET', '/api/users')).body.find(u => u.user === 'kimmy');
  assert.deepEqual([row.firstName, row.email], ['Kimberly', 'kim2@example.com'], 'admin sees the update');
  // Admin can edit names too
  assert.equal((await admin('PUT', `/api/users/${row.id}`, { firstName: 'Kim' })).body.firstName, 'Kim');
});

test('admin password reset forces a change again and logs them out', async () => {
  assert.equal((await admin('POST', `/api/users/${wifeId}/password`, { password: 'reset-pass-1' })).status, 200);
  assert.equal((await wife('GET', '/api/data')).status, 401, 'old session ended');
  const login = await wife('POST', '/api/login', { user: 'sarah', password: 'reset-pass-1' });
  assert.equal(login.body.mustChange, true);
  await wife('POST', '/api/password', { password: 'another pw 2' });
  assert.equal((await wife('GET', '/api/data')).body.entries.length, 1, 'her data survived the reset');
});

test('normal password change needs the current password', async () => {
  assert.equal((await admin('POST', '/api/password', { current: 'wrong', password: 'new password 1' })).status, 400);
  assert.equal((await admin('POST', '/api/password', { current: 'correct horse', password: 'new password 1' })).status, 200);
  assert.equal((await admin('GET', '/api/data')).status, 200, 'still signed in on this device');
});

test('admin can remove a user (and their data), but not themselves', async () => {
  const me = (await admin('GET', '/api/users')).body.find(u => u.user === 'alex');
  assert.equal((await admin('DELETE', `/api/users/${me.id}`)).status, 400);
  assert.equal((await admin('DELETE', `/api/users/${wifeId}`)).status, 200);
  assert.equal((await wife('GET', '/api/data')).status, 401);
  assert.equal((await stranger('POST', '/api/login', { user: 'sarah', password: 'another pw 2' })).status, 401);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
  assert.equal(stored.profiles[wifeId], undefined);
});

test('wrong password is rate limited', async () => {
  const h = { 'X-Forwarded-For': '10.9.9.9' };
  for (let i = 0; i < 10; i++) assert.equal((await stranger('POST', '/api/login', { user: 'alex', password: 'nope' }, h)).status, 401);
  assert.equal((await stranger('POST', '/api/login', { user: 'alex', password: 'new password 1' }, h)).status, 429);
});

test('logout locks data; usernames are case-insensitive', async () => {
  await admin('POST', '/api/logout', {});
  assert.equal((await admin('GET', '/api/data')).status, 401);
  assert.equal((await admin('POST', '/api/login', { user: 'ALEX', password: 'new password 1' })).status, 200);
});

test('path traversal is blocked', async () => {
  const res = await fetch(base + '/%2e%2e/server.js');
  assert.ok([403, 404].includes(res.status));
});
