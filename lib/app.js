// HTTP handler: static files + JSON API.
//
// data.json: { version: 2, profiles: { [userId]: { entries, supplies, shots, settings } } }
// Every user only ever sees their own profile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { jsonFile } from './store.js';
import { createAuth, validCredentials, validPassword, publicUser } from './auth.js';
import { migrateDataDir } from './migrate.js';
import { createMail, accountEmail, inviteEmail, resetLinkEmail, validEmail } from './mail.js';
import { createPush } from './push.js';
import { createUpdateCheck } from './version.js';
import { createBackup } from './backup.js';
import { weeklySummary, exportFiles } from './summary.js';
import { dueToday } from '../public/planning.js';
import { DEFAULT_PLAN } from '../public/titration.js';

export const ALL_SITES = ['Stomach – left', 'Stomach – right', 'Thigh – left', 'Thigh – right', 'Arm – left', 'Arm – right'];
// Main-page sections that can be reordered (Settings → Rearrange sections).
export const SECTIONS = ['logCard', 'nextCard', 'hero', 'stats', 'progressCard', 'chartCard', 'doseCard', 'shotCard', 'goalCard', 'historyCard'];
export const DEFAULT_SETTINGS = {
  goal: null, goalDate: null, unit: 'lb', shotDay: null, refillAt: 3, heightIn: null,
  sites: [...ALL_SITES], showShots: true, plan: { ...DEFAULT_PLAN }, protocols: [], customSites: [], medExtras: {},
  trackWeight: true, banners: { enabled: true, off: [] }, layout: [...SECTIONS],
  notify: { enabled: false, time: '08:00', off: [] }, weeklyEmail: { enabled: false, day: 0, time: '18:00' },
  monthlyExport: { enabled: false }, doseChart: false, reorderOn: true, reorderLead: 10, photos: false,
};
const newProfile = () => ({ entries: [], supplies: [], shots: [], inventory: [], settings: { ...DEFAULT_SETTINGS, sites: [...ALL_SITES], plan: { ...DEFAULT_PLAN } } });

const COOKIE = 'pt_session';
const OLD_COOKIE = 'wt_session'; // from before the rename; still accepted so nobody is logged out
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ---- validation helpers ----
const num = v => typeof v === 'number' && Number.isFinite(v);
const isTime = v => num(v) && v > 0;
const isWeight = v => num(v) && v > 20 && v < 1500; // lb
function optPos(v, max, label) {
  if (v === null || v === undefined || v === '') return null;
  if (!num(v) || v <= 0 || v > max) throw new HttpError(400, `Invalid ${label}`);
  return v;
}
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function cleanEntry(b) {
  if (!isWeight(b.weight)) throw new HttpError(400, 'Invalid weight');
  if (!isTime(b.t)) throw new HttpError(400, 'Invalid date');
  return { t: b.t, weight: b.weight, note: text(b.note, 200) };
}

function cleanSupply(b) {
  const name = text(b.name, 60);
  if (!name) throw new HttpError(400, 'Medication name is required');
  if (!['vial', 'pack'].includes(b.kind)) throw new HttpError(400, 'Invalid type');
  if (!isTime(b.opened)) throw new HttpError(400, 'Invalid date');
  const count = optPos(b.count, 1000, 'dose count');
  if (count != null && !Number.isInteger(count)) throw new HttpError(400, 'Dose count must be a whole number');
  const vial = b.kind === 'vial';
  return {
    name,
    kind: b.kind,
    mg: vial ? optPos(b.mg, 10000, 'vial strength') : null,
    waterMl: vial ? optPos(b.waterMl, 100, 'water amount') : null,
    count: vial ? null : count,
    price: b.price === 0 ? 0 : optPos(b.price, 100000, 'price'),
    opened: b.opened,
    done: b.done === true,
    adjustMg: vial && num(b.adjustMg) && Math.abs(b.adjustMg) <= 100000 ? Math.round(b.adjustMg * 10000) / 10000 : null,
    useWithin: vial && Number.isInteger(b.useWithin) && b.useWithin >= 1 && b.useWithin <= 365 ? b.useWithin : null,
    note: text(b.note, 300),
  };
}

function cleanShot(b, profile) {
  if (!isTime(b.t)) throw new HttpError(400, 'Invalid date');
  const supplyId = b.supplyId || null;
  if (supplyId && !profile.supplies.some(x => x.id === supplyId)) throw new HttpError(400, 'Unknown vial');
  const name = text(b.name, 60);
  if (!name) throw new HttpError(400, 'Medication name is required');
  if (!num(b.doseMg) || b.doseMg <= 0 || b.doseMg > 1000) throw new HttpError(400, 'Invalid dose');
  return {
    t: b.t,
    supplyId,
    name,
    doseMg: b.doseMg,
    units: optPos(b.units, 1000, 'units'),
    site: b.site ? text(b.site, 40) : null,
    groupId: typeof b.groupId === 'string' && /^[\w-]{1,40}$/.test(b.groupId) ? b.groupId : null,
    note: text(b.note, 200),
  };
}

function cleanSettings(b, current) {
  const s = { ...current };
  if ('goal' in b) {
    if (b.goal !== null && !isWeight(b.goal)) throw new HttpError(400, 'Invalid goal');
    s.goal = b.goal;
  }
  if ('goalDate' in b) {
    if (b.goalDate !== null && !isTime(b.goalDate)) throw new HttpError(400, 'Invalid goal date');
    s.goalDate = b.goalDate;
  }
  if ('unit' in b) {
    if (!['lb', 'kg'].includes(b.unit)) throw new HttpError(400, 'Invalid unit');
    s.unit = b.unit;
  }
  if ('shotDay' in b) {
    if (b.shotDay !== null && !(Number.isInteger(b.shotDay) && b.shotDay >= 0 && b.shotDay <= 6)) throw new HttpError(400, 'Invalid shot day');
    s.shotDay = b.shotDay;
  }
  if ('refillAt' in b) {
    if (!(Number.isInteger(b.refillAt) && b.refillAt >= 0 && b.refillAt <= 20)) throw new HttpError(400, 'Refill warning must be 0–20 doses');
    s.refillAt = b.refillAt;
  }
  if ('heightIn' in b) {
    if (b.heightIn !== null && !(num(b.heightIn) && b.heightIn >= 36 && b.heightIn <= 96)) throw new HttpError(400, 'Invalid height');
    s.heightIn = b.heightIn;
  }
  // Your own injection site names, usable by every medication.
  if ('customSites' in b) {
    if (!Array.isArray(b.customSites) || b.customSites.length > 20) throw new HttpError(400, 'Invalid custom sites');
    const seen = new Set(ALL_SITES.map(x => x.toLowerCase()));
    s.customSites = [];
    for (const raw of b.customSites) {
      const name = text(raw, 30).replace(/[<>]/g, '');
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      s.customSites.push(name);
    }
  }
  const allSites = [...ALL_SITES, ...(s.customSites || [])];
  const cleanRotation = list => allSites.filter(x => list.includes(x)); // keep rotation order stable
  if ('sites' in b) {
    if (!Array.isArray(b.sites) || !b.sites.length || !b.sites.every(x => allSites.includes(x))) throw new HttpError(400, 'Pick at least one injection site');
    s.sites = cleanRotation(b.sites);
  }
  // Per-medication extras: its own site rotation, new-vial defaults, hidden from the list.
  if ('medExtras' in b) {
    if (!b.medExtras || typeof b.medExtras !== 'object' || Array.isArray(b.medExtras) || Object.keys(b.medExtras).length > 40) throw new HttpError(400, 'Invalid medication settings');
    const out = {};
    for (const [key, v] of Object.entries(b.medExtras)) {
      const name = text(v?.name || key, 60);
      if (!name) continue;
      const opt = (x, label) => {
        if (x == null || x === '') return null;
        if (!num(x) || x < 0 || x > 100000) throw new HttpError(400, `Invalid ${label} for ${name}`);
        return x;
      };
      if (v.sites != null && (!Array.isArray(v.sites) || !v.sites.every(x => allSites.includes(x)))) throw new HttpError(400, `Unknown injection site for ${name}`);
      out[name.toLowerCase()] = {
        name,
        kind: v.kind === 'main' ? 'main' : v.kind === 'own' ? 'own' : null,
        sites: v.sites?.length ? cleanRotation(v.sites) : null,
        vialMg: opt(v.vialMg, 'powder mg'), waterMl: opt(v.waterMl, 'water'), price: opt(v.price, 'price'),
        useWithin: Number.isInteger(v.useWithin) && v.useWithin >= 1 && v.useWithin <= 365 ? v.useWithin : null,
        reorderLead: Number.isInteger(v.reorderLead) && v.reorderLead >= 0 && v.reorderLead <= 90 ? v.reorderLead : null,
        hidden: v.hidden === true,
      };
    }
    s.medExtras = out;
  }
  // Removing a custom site removes it from every rotation too.
  if ('customSites' in b) {
    if (s.sites) s.sites = cleanRotation(s.sites);
    for (const v of Object.values(s.medExtras || {})) if (v.sites) v.sites = cleanRotation(v.sites);
  }
  if ('showShots' in b) s.showShots = b.showShots === true;
  if ('trackWeight' in b) s.trackWeight = b.trackWeight === true;
  const hhmm = (v, label) => { if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, `Invalid ${label} time`); return v; };
  if ('notify' in b) {
    const v = b.notify || {};
    if (v.off != null && !Array.isArray(v.off)) throw new HttpError(400, 'Invalid notification settings');
    s.notify = { enabled: v.enabled === true, time: hhmm(v.time ?? '08:00', 'notification'), off: [...new Set((v.off || []).map(x => text(x, 60).toLowerCase()).filter(Boolean))].slice(0, 50) };
  }
  if ('weeklyEmail' in b) {
    const v = b.weeklyEmail || {};
    if (!(Number.isInteger(v.day ?? 0) && (v.day ?? 0) >= 0 && (v.day ?? 0) <= 6)) throw new HttpError(400, 'Invalid summary day');
    s.weeklyEmail = { enabled: v.enabled === true, day: v.day ?? 0, time: hhmm(v.time ?? '18:00', 'summary') };
  }
  if ('monthlyExport' in b) s.monthlyExport = { enabled: b.monthlyExport?.enabled === true };
  if ('doseChart' in b) s.doseChart = b.doseChart === true;
  if ('photos' in b) s.photos = b.photos === true;
  if ('onboarded' in b) s.onboarded = b.onboarded === true;
  if ('weightAsked' in b) s.weightAsked = b.weightAsked === true;
  if ('disclaimerOk' in b) s.disclaimerOk = b.disclaimerOk === true;
  if ('reorderOn' in b) s.reorderOn = b.reorderOn !== false;
  if ('reorderLead' in b) {
    if (!(Number.isInteger(b.reorderLead) && b.reorderLead >= 0 && b.reorderLead <= 90)) throw new HttpError(400, 'Order lead time must be 0–90 days');
    s.reorderLead = b.reorderLead;
  }
  if ('banners' in b) {
    const v = b.banners || {};
    if (v.off != null && !Array.isArray(v.off)) throw new HttpError(400, 'Invalid banner settings');
    s.banners = { enabled: v.enabled !== false, off: [...new Set((v.off || []).map(x => text(x, 60).toLowerCase()).filter(Boolean))].slice(0, 50) };
  }
  if ('layout' in b) {
    if (!Array.isArray(b.layout)) throw new HttpError(400, 'Invalid section order');
    const order = [...new Set(b.layout.filter(x => SECTIONS.includes(x)))];
    s.layout = [...order, ...SECTIONS.filter(x => !order.includes(x))]; // anything missing keeps its default place at the end
  }
  if ('plan' in b) s.plan = cleanPlan(b.plan, s.plan);
  if ('protocols' in b) s.protocols = cleanProtocols(b.protocols);
  return s;
}

// Inventory item: powder vials on hand, bacteriostatic water, or other supplies.
function cleanInventory(b, profile) {
  if (!['peptide', 'water', 'other'].includes(b.kind)) throw new HttpError(400, 'Invalid item type');
  const name = text(b.name, 60);
  if (!name) throw new HttpError(400, 'Enter a name');
  const int = (v, label, max = 100000) => {
    if (v == null || v === '') return 0;
    if (!Number.isInteger(v) || v < 0 || v > max) throw new HttpError(400, `Invalid ${label}`);
    return v;
  };
  const nonneg = (v, label) => {
    if (v == null || v === '') return null;
    if (!num(v) || v < 0 || v > 100000) throw new HttpError(400, `Invalid ${label}`);
    return v;
  };
  const optTime = (v, label) => {
    if (v == null || v === '') return null;
    if (!isTime(v)) throw new HttpError(400, `Invalid ${label}`);
    return v;
  };
  // Inventory number: keep what was given, otherwise the next free #001, #002…
  let code = text(b.code, 20);
  if (!code) {
    const used = profile.inventory.map(x => /^#(\d+)$/.exec(x.code || '')).filter(Boolean).map(m => Number(m[1]));
    code = `#${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`;
  }
  const item = {
    kind: b.kind, name, code,
    qty: int(b.qty, 'quantity'),
    lowAt: b.lowAt == null || b.lowAt === '' ? null : int(b.lowAt, 'low-stock number'),
    price: nonneg(b.price, 'price'),
    lot: text(b.lot, 40),
    received: optTime(b.received, 'date received'),
    expires: optTime(b.expires, 'expiry date'),
    note: text(b.note, 300),
  };
  if (b.kind === 'peptide') item.mg = nonneg(b.mg, 'mg per vial');
  if (b.kind === 'water') {
    item.bottleMl = nonneg(b.bottleMl, 'bottle size');
    item.openMl = nonneg(b.openMl, 'mL left in open bottle') ?? 0;
  }
  if (b.kind === 'other') {
    item.unit = text(b.unit, 20);
    item.perShot = b.perShot === true;
  }
  return item;
}

function cleanProtocols(list) {
  if (!Array.isArray(list) || list.length > 30) throw new HttpError(400, 'Invalid schedules');
  const seen = new Set();
  return list.map(b => {
    const name = text(b?.name, 60);
    if (!name) throw new HttpError(400, 'Schedule needs a medication name');
    if (seen.has(name.toLowerCase())) throw new HttpError(400, `Two schedules for ${name}`);
    seen.add(name.toLowerCase());
    if (!['daily', 'days', 'every', 'asneeded'].includes(b.freq)) throw new HttpError(400, 'Invalid schedule frequency');
    if (!['units', 'mg'].includes(b.unit)) throw new HttpError(400, 'Dose unit must be units or mg');
    const amt = (v, label, allowZero = false) => {
      if (v == null || v === '') { if (allowZero) return 0; throw new HttpError(400, `Enter the ${label}`); }
      if (!num(v) || v < 0 || v > 1000 || (!allowZero && v === 0)) throw new HttpError(400, `Invalid ${label}`);
      return v;
    };
    const days = b.freq === 'days' ? [...new Set((b.days || []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    if (b.freq === 'days' && !days.length) throw new HttpError(400, `Pick at least one day for ${name}`);
    const everyN = b.freq === 'every' ? b.everyN : null;
    if (b.freq === 'every' && !(Number.isInteger(everyN) && everyN >= 1 && everyN <= 90)) throw new HttpError(400, 'Every N days must be 1–90');
    if (b.start != null && !isTime(b.start)) throw new HttpError(400, 'Invalid schedule start date');
    const t = b.titrate || {};
    const titrate = t.enabled === true
      ? { enabled: true, step: amt(t.step, 'increase amount'), every: t.every, max: amt(t.max, 'max dose', true) }
      : { enabled: false };
    if (titrate.enabled && !(Number.isInteger(t.every) && t.every >= 1 && t.every <= 365)) throw new HttpError(400, 'Increase every N doses must be 1–365');
    const amount = amt(b.amount, 'dose');
    if (titrate.enabled && titrate.max > 0 && titrate.max < amount) throw new HttpError(400, 'Max dose must be at least the starting dose');
    // Units only mean a fixed dose on a vial of one strength: remember which (mg/mL).
    let refConc = null;
    if (b.unit === 'units' && b.refConc != null && b.refConc !== '') {
      if (!num(b.refConc) || b.refConc <= 0 || b.refConc > 1000) throw new HttpError(400, 'Invalid vial strength for the schedule');
      refConc = b.refConc;
    }
    return { name, freq: b.freq, days, everyN, start: b.start ?? null, unit: b.unit, amount, titrate, refConc };
  });
}

function cleanPlan(b, current) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'Invalid dose plan');
  const p = { ...DEFAULT_PLAN, ...current };
  const mg = (v, label) => {
    if (!num(v) || v <= 0 || v > 100) throw new HttpError(400, `Invalid ${label}`);
    return v;
  };
  if ('enabled' in b) p.enabled = b.enabled === true;
  if ('start' in b) {
    if (b.start !== null && !isTime(b.start)) throw new HttpError(400, 'Invalid plan start date');
    p.start = b.start;
  }
  if ('startDose' in b) p.startDose = mg(b.startDose, 'starting dose');
  if ('step' in b) p.step = mg(b.step, 'dose increase');
  if ('maxDose' in b) p.maxDose = mg(b.maxDose, 'max dose');
  if ('every' in b) {
    if (!(Number.isInteger(b.every) && b.every >= 1 && b.every <= 12)) throw new HttpError(400, 'Shots at each dose must be 1–12');
    p.every = b.every;
  }
  if (p.maxDose < p.startDose) throw new HttpError(400, 'Max dose must be at least the starting dose');
  return p;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Database errors in plain words.
function friendlyDbError(e) {
  const m = String(e?.message || e);
  if (/ECONNREFUSED/.test(m)) return 'Couldn’t connect: nothing is listening at that address and port (is PostgreSQL running and allowing network connections?)';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Couldn’t find that server name';
  if (/timeout|ETIMEDOUT|EHOSTUNREACH/i.test(m)) return 'Timed out connecting — check the address, port and firewall';
  if (/password authentication failed|no password supplied/i.test(m)) return 'Wrong database username or password';
  if (/database ".*" does not exist/.test(m)) return 'That database doesn’t exist yet — create it first';
  if (/no pg_hba.conf entry/.test(m)) return 'PostgreSQL refused this computer — allow it in pg_hba.conf';
  if (/permission denied/i.test(m)) return 'That user can’t create tables in this database — make it the owner';
  if (/does not support SSL/i.test(m)) return 'This server doesn’t use SSL — untick SSL';
  return m;
}

// Local/private addresses: loopback, 10/8, 172.16/12, 192.168/16, link-local, IPv6 ULA.
export function isPrivateIp(ip = '') {
  const v4 = String(ip).replace(/^::ffff:/, '');
  const m = v4.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = String(ip).toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || v6.startsWith('fe80:');
}
// Behind a reverse proxy the real client is the last X-Forwarded-For hop. Only trusted when the
// connection comes from a local proxy, so a client talking to the app directly can't fake it.
function clientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (xff && isPrivateIp(peer)) return xff.split(',').pop().trim();
  return peer;
}

export function createApp({ dataDir, publicDir, backup: backupOpt = null, log = console, mailTransportFactory, pushSender, scheduler = true, updateCheck = null, selfUpdateUnit = '/etc/systemd/system/peptidetracker-update.path', requireSetupCode = process.env.PT_DOCKER === '1' } = {}) {
  migrateDataDir(dataDir, log);
  // Older unit-based schedules didn't record the vial strength they were set on:
  // take it from the vial used for that medication's most recent shot.
  function fillRefConc(profile) {
    let changed = false;
    for (const pr of profile.settings?.protocols || []) {
      if (pr.unit !== 'units' || pr.refConc) continue;
      const same = x => x.name.trim().toLowerCase() === pr.name.trim().toLowerCase();
      const conc = v => (v && v.kind === 'vial' && v.mg > 0 && v.waterMl > 0 ? v.mg / v.waterMl : null);
      const shot = [...(profile.shots || [])].filter(same).sort((a, b) => b.t - a.t).find(x => conc((profile.supplies || []).find(v => v.id === x.supplyId)));
      const vial = shot ? profile.supplies.find(v => v.id === shot.supplyId) : (profile.supplies || []).filter(same).find(v => conc(v));
      if (vial) { pr.refConc = Math.round(conc(vial) * 10000) / 10000; changed = true; }
    }
    return changed;
  }
  const store = jsonFile(dataDir, 'data.json', { version: 2, profiles: {} });
  const sync = backupOpt || createBackup({ dataDir, log }); // PostgreSQL backup (may be off)
  // Docker: the visitor's address can't be trusted to tell "home network" from "internet" (NAT),
  // so creating the first account needs a one-time code shown in the container log instead.
  const codeFile = path.join(dataDir, 'setup-code');
  let setupCode = null;
  function refreshSetupCode() {
    if (!requireSetupCode || auth.hasUsers()) { setupCode = null; fs.rmSync(codeFile, { force: true }); return; }
    if (!setupCode) {
      try { setupCode = fs.readFileSync(codeFile, 'utf8').trim(); } catch {}
      if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(setupCode || '')) {
        const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const pick = () => Array.from(crypto.randomBytes(4), b => abc[b % abc.length]).join('');
        setupCode = `${pick()}-${pick()}`;
        fs.writeFileSync(codeFile, setupCode + '\n', { mode: 0o600 });
      }
    }
    log.log(`\n  ==> First-time setup code: ${setupCode}\n      Enter it on the "Create your login" screen.\n`);
  }
  // Checks before the first account can be created (or restored from a backup).
  function firstRunGate(req, body, ip) {
    if (auth.hasUsers()) return [403, 'Account already exists'];
    if (setupCode) {
      if (auth.rateLimited(ip)) return [429, 'Too many attempts. Try again in 15 minutes.'];
      const given = Buffer.from(String(body.setupCode || '').trim().toUpperCase()), want = Buffer.from(setupCode);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        auth.recordFail(ip);
        return [403, 'Wrong setup code. It’s in the container log: docker logs peptidetracker'];
      }
      return null;
    }
    // First-time setup only from the local network, never through the reverse proxy,
    // so nobody on the internet can claim the admin account before you do.
    if (req.headers['x-forwarded-for'] || !isPrivateIp(req.socket.remoteAddress)) {
      return [403, 'Create your login from your home network first (open the app by its local IP address).'];
    }
    return null;
  }
  const appConfig = jsonFile(dataDir, 'app.json', {}); // install-wide options set by the admin (Grafana address)
  // Link to this person's view of the PeptideTracker dashboard (uid "peptidetracker", person picker preselected).
  const grafanaLink = u => { const g = appConfig.read().grafanaUrl; return g ? `${g}/d/peptidetracker/peptidetracker?var-person=${encodeURIComponent(u.id)}` : null; };
  const auth = createAuth(dataDir);
  queueMicrotask(refreshSetupCode); // after the rest of setup
  const mail = createMail(dataDir, { transportFactory: mailTransportFactory });
  const updates = updateCheck || createUpdateCheck({ enabled: scheduler && process.env.UPDATE_CHECK !== '0', log });
  const push = createPush(dataDir, { sender: pushSender, contact: () => (mail.raw()?.fromAddress ? `mailto:${mail.raw().fromAddress}` : null) });
  const loaded = store.read();
  const db = { version: 2, profiles: loaded.profiles || {} };
  if (Object.values(db.profiles).map(fillRefConc).some(Boolean)) store.write(db);

  // Profile for a user, created on first use with defaults filled in.
  function profileOf(userId) {
    const p = db.profiles[userId] ||= newProfile();
    p.entries ||= []; p.supplies ||= []; p.shots ||= []; p.inventory ||= [];
    p.settings = { ...DEFAULT_SETTINGS, sites: [...ALL_SITES], ...p.settings };
    p.settings.plan = { ...DEFAULT_PLAN, ...p.settings.plan };
    return p;
  }
  const save = () => {
    for (const p of Object.values(db.profiles)) {
      p.entries.sort((a, b) => a.t - b.t);
      p.supplies.sort((a, b) => a.opened - b.opened);
      p.shots.sort((a, b) => a.t - b.t);
    }
    store.write(db);
    sync.schedule();
  };
  // Everything a backup needs to rebuild the app, including logins.
  sync.setSource(() => ({ users: auth.list(), profiles: db.profiles, mail: mail.raw() }));

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    // Requiring JSON blocks cross-site form posts (CSRF) along with SameSite cookies.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Expected JSON');
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1e5) throw new HttpError(413, 'Body too large');
    }
    try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  function sessionCookie(req, token, maxAge, name = COOKIE) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }
  function loginResponse(req, res, user) {
    const s = auth.createSession(user.id);
    return send(res, 200, { ok: true, mustChange: !!user.mustChange }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }

  function serveStatic(req, res, pathname) {
    const file = path.normalize(path.join(publicDir, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(buf);
    });
  }

  // Stock changes that go with creating things:
  //  - a new vial "mixed" from inventory takes one powder vial and its water out of stock
  //  - a new shot uses up supplies marked "one per shot" (e.g. syringes)
  // Returns notes about anything that ran short.
  function applyStock(list, item, body, profile) {
    const notes = [];
    const inv = profile.inventory;
    if (list === 'supplies') {
      const powder = body.fromInventory && inv.find(x => x.id === body.fromInventory && x.kind === 'peptide');
      if (powder) {
        if (powder.qty > 0) powder.qty -= 1; else notes.push(`${powder.name} was already at 0 in stock`);
        item.invCode = powder.code || null;
        if (powder.lot) item.lot = powder.lot;
      }
      const water = body.waterFrom && inv.find(x => x.id === body.waterFrom && x.kind === 'water');
      if (water && item.waterMl > 0) {
        let need = item.waterMl;
        const take = () => { const t = Math.min(need, water.openMl || 0); water.openMl = Math.round(((water.openMl || 0) - t) * 1000) / 1000; need -= t; };
        take();
        while (need > 1e-9 && water.qty > 0 && water.bottleMl > 0) { water.qty -= 1; water.openMl = (water.openMl || 0) + water.bottleMl; take(); }
        if (need > 1e-9) notes.push(`Not enough ${water.name} in stock for ${item.waterMl} mL`);
      }
    }
    // A dose split across two vials is still one injection: only its first part uses supplies.
    if (list === 'shots' && !(item.groupId && profile.shots.some(x => x.groupId === item.groupId))) {
      for (const x of inv) if (x.kind === 'other' && x.perShot && x.qty > 0) x.qty -= 1;
    }
    return notes;
  }

  // CRUD for a list in the user's profile (entries, supplies, shots, inventory).
  async function crud(req, res, profile, list, id, clean) {
    if (!id && req.method === 'POST') {
      const body = await readJson(req);
      const item = { id: crypto.randomUUID(), ...clean(body, profile) };
      const stockNotes = applyStock(list, item, body, profile);
      profile[list].push(item);
      save();
      if (stockNotes.length) return send(res, 201, { ...item, stockNotes });
      save();
      return send(res, 201, item);
    }
    const idx = id ? profile[list].findIndex(x => x.id === id) : -1;
    if (id && idx === -1) return send(res, 404, { error: 'Not found' });
    if (id && req.method === 'PUT') {
      const old = profile[list][idx];
      profile[list][idx] = { id, ...clean(await readJson(req), profile) };
      // Keep where a vial came from when it's edited.
      if (list === 'supplies') for (const k of ['invCode', 'lot']) if (old[k] != null && profile[list][idx][k] == null) profile[list][idx][k] = old[k];
      save();
      return send(res, 200, profile[list][idx]);
    }
    if (id && req.method === 'DELETE') {
      const [gone] = profile[list].splice(idx, 1);
      // Shots from a deleted vial stay, just unlinked.
      if (list === 'supplies') profile.shots.forEach(s => { if (s.supplyId === gone.id) s.supplyId = null; });
      save();
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  // Link base for emails: the saved app link, else the address the request came in on.
  function appUrlFor(req) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return mail.appUrl() || (req.headers.host ? `${proto}://${req.headers.host}` : '');
  }
  const nameOf = u => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.user;
  const cleanName = v => text(v, 60).replace(/[\r\n<>]/g, '');

  // Email someone their username + temporary password. Returns { emailed, emailError }.
  async function emailAccount(kind, u, password, me, req) {
    if (!u.email) return { emailed: false };
    try {
      await mail.send({ to: u.email, ...accountEmail({ kind, user: u.user, password, appUrl: appUrlFor(req), by: nameOf(me), name: u.firstName }) });
      return { emailed: true };
    } catch (e) {
      return { emailed: false, emailError: e.message };
    }
  }

  // ---- Admin → Backup & Grafana ----
  async function adminApi(req, res, p, me) {
    if (me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    if (p === '/api/admin/grafana' && req.method === 'GET') return send(res, 200, { url: appConfig.read().grafanaUrl || '' });
    if (p === '/api/admin/grafana' && req.method === 'PUT') {
      const url = String((await readJson(req)).url ?? '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s"'<>]+$/i.test(url)) return send(res, 400, { error: 'Enter the Grafana address, starting with http:// or https://' });
      appConfig.write({ ...appConfig.read(), grafanaUrl: url || undefined });
      return send(res, 200, { url, link: grafanaLink(me) });
    }
    if (p === '/api/admin/backup' && req.method === 'GET') return send(res, 200, sync.settings());
    if (p === '/api/admin/backup/test' && req.method === 'POST') {
      try { const { existing } = await sync.test(await readJson(req)); return send(res, 200, { ok: true, existing }); }
      catch (e) { return send(res, 400, { error: friendlyDbError(e) }); }
    }
    if (p === '/api/admin/backup' && req.method === 'PUT') {
      const b = await readJson(req);
      try { return send(res, 200, await sync.save(b, { overwrite: b.overwrite === true })); }
      catch (e) { return send(res, e.existing ? 409 : 400, { error: friendlyDbError(e), existing: e.existing }); }
    }
    if (p === '/api/admin/backup' && req.method === 'DELETE') {
      try { await sync.disable(); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, sync.settings());
    }
    if (p === '/api/admin/backup/now' && req.method === 'POST') {
      await sync.flush();
      return send(res, 200, sync.settings());
    }
    // ---- updates: release notes, check now, and the Update now button ----
    const statusFile = path.join(dataDir, 'update-status.json'), requestFile = path.join(dataDir, 'update-request');
    const readStatus = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return null; } };
    if (p === '/api/admin/update' && req.method === 'GET') {
      let logTail = '';
      try { logTail = fs.readFileSync(path.join(dataDir, 'update.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-30).join('\n'); } catch {}
      return send(res, 200, { ...updates.details(), docker: process.env.PT_DOCKER === '1', canSelfUpdate: fs.existsSync(selfUpdateUnit), requested: fs.existsSync(requestFile), status: readStatus(), log: logTail });
    }
    if (p === '/api/admin/update/check' && req.method === 'POST') {
      await updates.check();
      return send(res, 200, updates.details());
    }
    if (p === '/api/admin/update' && req.method === 'POST') {
      if (!fs.existsSync(selfUpdateUnit)) return send(res, 400, { error: process.env.PT_DOCKER === '1' ? 'This is a Docker install — update with: docker compose pull && docker compose up -d' : 'This install can’t update itself from the app — type update in the container’s console.' });
      if (!updates.available()) return send(res, 400, { error: 'You’re already on the newest version.' });
      // Only a request: systemd sees this file and runs the official updater as root.
      fs.writeFileSync(requestFile, JSON.stringify({ by: me.user, at: Date.now(), to: updates.details().latest }));
      fs.writeFileSync(statusFile, JSON.stringify({ state: 'requested', from: updates.details().current, to: updates.details().latest, message: 'Starting', at: Date.now() }));
      log.log(`[update] ${me.user} started an update to v${updates.details().latest}`);
      return send(res, 202, { ok: true });
    }
    if (p === '/api/admin/grafana-dashboard' && req.method === 'GET') {
      const file = path.join(publicDir, '..', 'grafana', 'peptidetracker-dashboard.json');
      if (!fs.existsSync(file)) return send(res, 404, { error: 'Dashboard file not found' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="peptidetracker-dashboard.json"', ...SECURITY_HEADERS });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }
  async function mailApi(req, res, p, me) {
    if (me.role !== 'admin') return send(res, 403, { error: 'Only the admin can change email settings' });
    if (p === '/api/mail' && req.method === 'GET') return send(res, 200, mail.publicConfig());
    if (p === '/api/mail' && req.method === 'PUT') {
      try {
        const cfg = mail.save(await readJson(req));
        sync.schedule();
        return send(res, 200, cfg);
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/mail' && req.method === 'DELETE') {
      mail.clear();
      sync.schedule();
      return send(res, 200, { configured: false });
    }
    if (p === '/api/mail/test' && req.method === 'POST') {
      const { to } = await readJson(req);
      try {
        await mail.send({
          to,
          subject: 'PeptideTracker test email',
          text: `This is a test from PeptideTracker, sent by ${me.user}. Email is working.`,
          html: `<p style="font-family:system-ui,sans-serif">This is a test from <b>PeptideTracker</b>, sent by ${me.user.replace(/[<>&]/g, '')}. Email is working.</p>`,
        });
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    return send(res, 404, { error: 'Not found' });
  }

  async function invitesApi(req, res, p, me) {
    if (me.role !== 'admin') return send(res, 403, { error: 'Only the admin can invite people' });
    if (p === '/api/invites' && req.method === 'GET') return send(res, 200, auth.invites());
    const linkFor = token => `${appUrlFor(req)}/?invite=${token}`;
    const sendLink = (invite, token) => mail.send({ to: invite.email, ...inviteEmail({ link: linkFor(token), by: nameOf(me) }) });
    // The link always comes back so the admin can copy or text it; emailing it is optional.
    if (p === '/api/invites' && req.method === 'POST') {
      const b = await readJson(req);
      const email = String(b.email ?? '').trim();
      const name = cleanName(b.name);
      if (email && !validEmail(email)) return send(res, 400, { error: 'That email address doesn’t look right' });
      const wantsEmail = !!email && b.sendEmail !== false;
      if (wantsEmail && !mail.configured()) return send(res, 400, { error: 'Email isn’t set up — untick “Also email it” and copy the link instead' });
      let created;
      try { created = auth.createInvite(email || null, me.id, name); } catch (e) { return send(res, 400, { error: e.message }); }
      if (wantsEmail) {
        try { await sendLink(created.invite, created.token); } catch (e) {
          auth.cancelInvite(created.invite.id);
          return send(res, 400, { error: e.message });
        }
      }
      const { tokenHash, ...invite } = created.invite;
      return send(res, 201, { ...invite, link: linkFor(created.token), emailed: wantsEmail });
    }
    let m;
    // A fresh link (the old one stops working); emailed again if the invite has an email address.
    if ((m = p.match(/^\/api\/invites\/([\w-]+)\/resend$/)) && req.method === 'POST') {
      try {
        const { invite, token } = auth.renewInvite(m[1]);
        const b = await readJson(req).catch(() => ({}));
        const emailed = !!invite.email && mail.configured() && b.sendEmail !== false;
        if (emailed) await sendLink(invite, token);
        return send(res, 200, { ok: true, link: linkFor(token), emailed });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if ((m = p.match(/^\/api\/invites\/([\w-]+)$/)) && req.method === 'DELETE') {
      auth.cancelInvite(m[1]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  async function usersApi(req, res, p, me) {
    if (me.role !== 'admin') return send(res, 403, { error: 'Only the admin can manage users' });
    if (p === '/api/users' && req.method === 'GET') return send(res, 200, auth.list().map(publicUser));
    if (p === '/api/users' && req.method === 'POST') {
      const { user, password, email, sendInvite, firstName, lastName } = await readJson(req);
      const addr = String(email ?? '').trim();
      if (addr && !validEmail(addr)) return send(res, 400, { error: 'That email address doesn’t look right' });
      let u;
      try {
        u = auth.create({ user: String(user ?? '').trim(), password, role: 'user', mustChange: true, email: addr || null, firstName: cleanName(firstName), lastName: cleanName(lastName) });
      } catch (e) { return send(res, 400, { error: e.message }); }
      profileOf(u.id);
      save();
      const result = sendInvite && addr ? await emailAccount('invite', u, password, me, req) : { emailed: false };
      return send(res, 201, { ...publicUser(u), ...result, loginLink: `${appUrlFor(req)}/?u=${encodeURIComponent(u.user)}` });
    }
    let m;
    if ((m = p.match(/^\/api\/users\/([\w-]+)\/password$/)) && req.method === 'POST') {
      const target = auth.get(m[1]);
      if (!target) return send(res, 404, { error: 'No such user' });
      const { password, sendEmail } = await readJson(req);
      try {
        auth.setPassword(target.id, password, { mustChange: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
      sync.schedule();
      const u = auth.get(target.id);
      const result = sendEmail ? await emailAccount('reset', u, password, me, req) : { emailed: false };
      return send(res, 200, { ...publicUser(u), ...result, loginLink: `${appUrlFor(req)}/?u=${encodeURIComponent(u.user)}` });
    }
    if ((m = p.match(/^\/api\/users\/([\w-]+)$/)) && req.method === 'PUT') {
      const target = auth.get(m[1]);
      if (!target) return send(res, 404, { error: 'No such user' });
      const b = await readJson(req);
      const changes = {};
      if ('email' in b) {
        const addr = String(b.email ?? '').trim();
        if (addr && !validEmail(addr)) return send(res, 400, { error: 'That email address doesn’t look right' });
        changes.email = addr || null;
      }
      if ('firstName' in b) changes.firstName = cleanName(b.firstName);
      if ('lastName' in b) changes.lastName = cleanName(b.lastName);
      try { auth.updateProfile(target.id, changes); } catch (e) { return send(res, 400, { error: e.message }); }
      sync.schedule();
      return send(res, 200, publicUser(auth.get(target.id)));
    }
    if ((m = p.match(/^\/api\/users\/([\w-]+)$/)) && req.method === 'DELETE') {
      const target = auth.get(m[1]);
      if (!target) return send(res, 404, { error: 'No such user' });
      if (target.id === me.id) return send(res, 400, { error: "You can't remove your own account" });
      auth.remove(target.id);
      push.removeUser(target.id);
      fs.rmSync(photoDir(target.id), { recursive: true, force: true });
      delete db.profiles[target.id];
      save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  async function api(req, res, p) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE] || cookies[OLD_COOKIE];
    const me = auth.sessionUser(token);
    const ip = clientIp(req);
    // Signed in with the pre-rename cookie: move the session to the new cookie and drop the old one.
    if (me && !cookies[COOKIE] && cookies[OLD_COOKIE]) {
      res.setHeader('Set-Cookie', [sessionCookie(req, token, 90 * 86400), sessionCookie(req, '', 0, OLD_COOKIE)]);
    }

    // ---- routes that work without a session ----
    if (p === '/api/auth' && req.method === 'GET') {
      return send(res, 200, {
        setupNeeded: !auth.hasUsers(),
        setupCode: !!setupCode && !auth.hasUsers(),
        loggedIn: !!me,
        user: me?.user ?? null,
        role: me?.role ?? null,
        mustChange: !!me?.mustChange,
        firstName: me?.firstName ?? '',
      });
    }
    let m;
    // ---- accept an email invite: choose username, name and password ----
    if ((m = p.match(/^\/api\/invite\/([\w-]+)$/))) {
      if (auth.rateLimited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const invite = auth.inviteByToken(m[1]);
      if (!invite) {
        auth.recordFail(ip);
        return send(res, 404, { error: 'This invite link has expired or was already used. Ask for a new one.' });
      }
      if (req.method === 'GET') return send(res, 200, { email: invite.email, name: invite.name || '' });
      if (req.method === 'POST') {
        const b = await readJson(req);
        const firstName = cleanName(b.firstName), lastName = cleanName(b.lastName);
        if (!firstName) return send(res, 400, { error: 'Enter your first name' });
        // A texted link has no email yet: they can add one (used for sign-in and password resets).
        let email = invite.email;
        if (!email && String(b.email ?? '').trim()) {
          email = String(b.email).trim();
          if (!validEmail(email)) return send(res, 400, { error: 'That email address doesn’t look right' });
        }
        let u;
        try {
          u = auth.create({ user: String(b.user ?? '').trim(), password: b.password, role: 'user', mustChange: false, email, firstName, lastName });
        } catch (e) { return send(res, 400, { error: e.message }); }
        auth.cancelInvite(invite.id);
        profileOf(u.id);
        save();
        return loginResponse(req, res, u);
      }
    }
    // ---- forgot password: always the same answer, so it can't be used to find accounts ----
    if (p === '/api/forgot' && req.method === 'POST') {
      const key = `forgot:${ip}`;
      if (auth.rateLimited(key)) return send(res, 429, { error: 'Too many requests. Try again in 15 minutes.' });
      auth.recordFail(key);
      const { login } = await readJson(req);
      const u = auth.byLogin(String(login ?? '').trim());
      if (u?.email && mail.configured()) {
        const link = `${appUrlFor(req)}/?reset=${auth.createReset(u.id)}`;
        // Not awaited: replying at once means timing doesn't reveal whether the account exists.
        mail.send({ to: u.email, ...resetLinkEmail({ link, user: u.user, name: u.firstName }) })
          .catch(e => log.error('[mail] reset email failed:', e.message));
      }
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/reset\/([\w-]+)$/))) {
      if (auth.rateLimited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const u = auth.resetUser(m[1]);
      if (!u) {
        auth.recordFail(ip);
        return send(res, 404, { error: 'This reset link has expired or was already used. Request a new one.' });
      }
      if (req.method === 'GET') return send(res, 200, { user: u.user });
      if (req.method === 'POST') {
        const { password } = await readJson(req);
        try { auth.setPassword(u.id, password, { mustChange: false }); } catch (e) { return send(res, 400, { error: e.message }); }
        auth.consumeReset(m[1]);
        sync.schedule();
        return loginResponse(req, res, auth.get(u.id));
      }
    }
    // First-time setup, option 2: rebuild this install from an existing PostgreSQL backup.
    if (p === '/api/setup/restore' && req.method === 'POST') {
      const body = await readJson(req);
      const blocked = firstRunGate(req, body, ip);
      if (blocked) return send(res, blocked[0], { error: blocked[1] });
      if (auth.rateLimited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      try {
        const { backup, activate } = await sync.restoreFrom(body);
        auth.replaceAll(backup.users);
        mail.restore(backup.mail);
        db.profiles = backup.profiles;
        for (const p_ of Object.values(db.profiles)) fillRefConc(p_);
        store.write(db);
        activate();
        sync.setSource(() => ({ users: auth.list(), profiles: db.profiles, mail: mail.raw() }));
        refreshSetupCode();
        const count = k => Object.values(backup.profiles).reduce((n, x) => n + (x[k]?.length || 0), 0);
        log.log(`[restore] ${backup.users.length} users, ${count('entries')} weigh-ins, ${count('shots')} shots from PostgreSQL`);
        return send(res, 200, { users: backup.users.length, entries: count('entries'), shots: count('shots') });
      } catch (e) {
        auth.recordFail(ip);
        return send(res, 400, { error: friendlyDbError(e) });
      }
    }
    if (p === '/api/setup' && req.method === 'POST') {
      const body = await readJson(req);
      const blocked = firstRunGate(req, body, ip);
      if (blocked) return send(res, blocked[0], { error: blocked[1] });
      const { user, password } = body;
      const problem = validCredentials(user, password);
      if (problem) return send(res, 400, { error: problem });
      const admin = auth.create({ user, password, role: 'admin', mustChange: false });
      // Data from before accounts existed belongs to the first admin.
      if (db.profiles.__unclaimed) { db.profiles[admin.id] = db.profiles.__unclaimed; delete db.profiles.__unclaimed; }
      profileOf(admin.id);
      save();
      refreshSetupCode();
      return loginResponse(req, res, admin);
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (auth.rateLimited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const { user, password } = await readJson(req);
      const u = auth.verify(user, password);
      if (!u) {
        auth.recordFail(ip);
        return send(res, 401, { error: 'Wrong username/email or password' });
      }
      auth.clearFails(ip);
      return loginResponse(req, res, u);
    }
    if (p === '/api/logout' && req.method === 'POST') {
      // End every session this browser holds (new and pre-rename cookie) and clear both.
      for (const t of new Set([cookies[COOKIE], cookies[OLD_COOKIE]].filter(Boolean))) auth.endSession(t);
      return send(res, 200, { ok: true }, { 'Set-Cookie': [sessionCookie(req, '', 0), sessionCookie(req, '', 0, OLD_COOKIE)] });
    }

    // ---- everything below needs a session ----
    if (!me) return send(res, 401, { error: 'Not logged in' });

    if (p === '/api/password' && req.method === 'POST') {
      const { current, password } = await readJson(req);
      // A temporary password set by the admin was just used to sign in, so it isn't asked again.
      if (!me.mustChange && !auth.verify(me.user, current)) return send(res, 400, { error: 'Current password is wrong' });
      const problem = validPassword(password);
      if (problem) return send(res, 400, { error: problem });
      if (me.mustChange && auth.verify(me.user, password)) return send(res, 400, { error: 'Pick a new password, not the temporary one' });
      auth.setPassword(me.id, password, { mustChange: false, keepToken: token });
      sync.schedule();
      return send(res, 200, { ok: true });
    }

    // Until a temporary password is replaced, nothing else is allowed.
    if (me.mustChange) return send(res, 403, { error: 'Please choose a new password first', mustChange: true });

    // ---- notifications ----
    if (p === '/api/push/key' && req.method === 'GET') return send(res, 200, { key: push.publicKey(), devices: push.count(me.id) });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      try { push.subscribe(me.id, (await readJson(req)).subscription, req.headers['user-agent']); }
      catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { devices: push.count(me.id) });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      push.unsubscribe(me.id, String((await readJson(req)).endpoint || ''));
      return send(res, 200, { devices: push.count(me.id) });
    }
    if (p === '/api/push/test' && req.method === 'POST') {
      const items = dueToday(profileOf(me.id), Date.now());
      const n = await push.notify(me.id, items.length
        ? { title: 'Shots due today', body: items.map(i => `${i.name}: ${i.text}`).join(' · '), tag: 'test' }
        : { title: 'PeptideTracker', body: 'Notifications are working. Nothing is due today.', tag: 'test' });
      return send(res, 200, { sent: n });
    }
    if (p === '/api/summary/send' && req.method === 'POST') {
      try { await sendSummary(me, profileOf(me.id), Date.now(), req); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/export/send' && req.method === 'POST') {
      try { await sendExport(me, profileOf(me.id)); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me' && req.method === 'PUT') {
      const b = await readJson(req);
      const changes = { firstName: cleanName(b.firstName), lastName: cleanName(b.lastName) };
      const addr = String(b.email ?? '').trim();
      if (addr !== (me.email || '')) {
        if (addr && !validEmail(addr)) return send(res, 400, { error: 'That email address doesn’t look right' });
        // Changing where password resets go needs the current password.
        if (!auth.verify(me.user, b.current)) return send(res, 400, { error: 'Enter your current password to change your email' });
        changes.email = addr || null;
      }
      try { auth.updateProfile(me.id, changes); } catch (e) { return send(res, 400, { error: e.message }); }
      sync.schedule();
      return send(res, 200, publicUser(auth.get(me.id)));
    }
    if (p.startsWith('/api/invites')) return invitesApi(req, res, p, me);
    if (p.startsWith('/api/users')) return usersApi(req, res, p, me);
    if (p.startsWith('/api/mail')) return mailApi(req, res, p, me);
    if (p.startsWith('/api/admin/')) return adminApi(req, res, p, me);

    const profile = profileOf(me.id);
    // Everything this person has, as one file they keep (never locked in).
    if (p === '/api/export' && req.method === 'GET') {
      const { sent, ...mine } = profile;
      const body = JSON.stringify({
        app: 'PeptideTracker', version: updates.info().current, exportedAt: new Date().toISOString(),
        account: { username: me.user, firstName: me.firstName || '', lastName: me.lastName || '', email: me.email || null },
        note: 'Weights are in lb. Times are milliseconds since 1970 (UTC). Photo images are not included.',
        ...mine,
      }, null, 2);
      const name = `peptidetracker-${me.user.replace(/[^\w.-]/g, '')}-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(body);
    }
    if (p === '/api/data' && req.method === 'GET') {
      const { sent, ...mine } = profile;
      const version = updates.info();
      if (me.role !== 'admin') { delete version.latest; delete version.url; }
      return send(res, 200, { ...mine, me: publicUser(me), mailReady: mail.configured(), sync: sync.status(), version, grafanaUrl: grafanaLink(me) });
    }

    if (p.startsWith('/api/photos')) return photosApi(req, res, p, me, profile);
    if ((m = p.match(/^\/api\/entries(?:\/([\w-]+))?$/))) return crud(req, res, profile, 'entries', m[1], cleanEntry);
    if ((m = p.match(/^\/api\/supplies(?:\/([\w-]+))?$/))) return crud(req, res, profile, 'supplies', m[1], cleanSupply);
    if ((m = p.match(/^\/api\/shots(?:\/([\w-]+))?$/))) return crud(req, res, profile, 'shots', m[1], cleanShot);
    if ((m = p.match(/^\/api\/inventory(?:\/([\w-]+))?$/))) return crud(req, res, profile, 'inventory', m[1], cleanInventory);

    if (p === '/api/settings' && req.method === 'PUT') {
      profile.settings = cleanSettings(await readJson(req), profile.settings);
      save();
      return send(res, 200, profile.settings);
    }

    return send(res, 404, { error: 'Not found' });
  }

  // ---- progress photos (optional; files stay on this server, never in the database backup) ----
  const photoDir = userId => path.join(dataDir, 'photos', String(userId).replace(/[^\w-]/g, ''));
  async function photosApi(req, res, p, me, profile) {
    profile.photos ||= [];
    let m;
    if (p === '/api/photos' && req.method === 'GET') return send(res, 200, profile.photos);
    if (p === '/api/photos' && req.method === 'POST') {
      if (profile.settings.photos !== true) return send(res, 400, { error: 'Turn on progress photos in Settings first' });
      // Raw JPEG body (the page shrinks the picture first). A non-form type also blocks cross-site posts.
      if (req.headers['content-type'] !== 'image/jpeg') return send(res, 415, { error: 'Expected a JPEG image' });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 8e6) return send(res, 413, { error: 'Photo too large' }); chunks.push(c); }
      const buf = Buffer.concat(chunks);
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return send(res, 400, { error: 'Not a JPEG image' });
      if (profile.photos.length >= 500) return send(res, 400, { error: 'Photo limit reached (500)' });
      const q = new URL(req.url, 'http://x').searchParams;
      const t = Number(q.get('t'));
      const photo = { id: crypto.randomUUID(), t: Number.isFinite(t) && t > 0 ? t : Date.now(), note: String(q.get('note') || '').trim().slice(0, 200) };
      fs.mkdirSync(photoDir(me.id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(photoDir(me.id), `${photo.id}.jpg`), buf, { mode: 0o600 });
      profile.photos.push(photo);
      profile.photos.sort((a, b) => a.t - b.t);
      save();
      return send(res, 200, photo);
    }
    if ((m = p.match(/^\/api\/photos\/([\w-]{36})(\/image)?$/))) {
      const photo = profile.photos.find(x => x.id === m[1]);
      if (!photo) return send(res, 404, { error: 'Not found' });
      const file = path.join(photoDir(me.id), `${photo.id}.jpg`);
      if (m[2] && req.method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ...SECURITY_HEADERS });
        return fs.createReadStream(file).pipe(res);
      }
      if (!m[2] && req.method === 'PUT') {
        const b = await readJson(req);
        if (b.t != null) { if (!(Number.isFinite(b.t) && b.t > 0)) return send(res, 400, { error: 'Invalid date' }); photo.t = b.t; }
        if (b.note != null) photo.note = String(b.note).trim().slice(0, 200);
        profile.photos.sort((a, b) => a.t - b.t);
        save();
        return send(res, 200, photo);
      }
      if (!m[2] && req.method === 'DELETE') {
        fs.rmSync(file, { force: true });
        profile.photos = profile.photos.filter(x => x.id !== photo.id);
        save();
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ---- scheduled jobs: morning notification, weekly summary, monthly export ----
  const pad = n => String(n).padStart(2, '0');
  const localDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const localTime = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  async function sendSummary(user, profile, now, req) {
    if (!user.email) throw new Error('Add your email in ⚙ menu → My account first');
    const appUrl = mail.appUrl() || (req ? appUrlFor(req) : '');
    await mail.send({ to: user.email, ...weeklySummary(profile, { name: user.firstName || user.user, appUrl, now }) });
  }
  async function sendExport(user, profile) {
    if (!user.email) throw new Error('Add your email in ⚙ menu → My account first');
    const { sent, ...data } = profile;
    await mail.send({
      to: user.email,
      subject: 'Your PeptideTracker data export',
      text: 'Attached: all your data (JSON) and your weigh-ins and shots as spreadsheets (CSV).',
      html: '<p style="font-family:system-ui,sans-serif">Attached: all your data (JSON) and your weigh-ins and shots as spreadsheets (CSV).</p>',
      attachments: exportFiles(data, user.user),
    });
  }
  async function tick(now = Date.now()) {
    const today = localDay(now), time = localTime(now), d = new Date(now);
    let changed = false;
    for (const user of auth.list()) {
      if (!db.profiles[user.id]) continue;
      const profile = profileOf(user.id);
      const st = profile.settings || {};
      const sent = (profile.sent ||= {});
      try {
        if (st.notify?.enabled && st.showShots !== false && time >= (st.notify.time || '08:00') && sent.notify !== today) {
          sent.notify = today; changed = true;
          const off = st.notify.off || [];
          const items = dueToday(profile, now).filter(i => !off.includes(i.key));
          if (items.length) {
            await push.notify(user.id, {
              title: items.some(i => i.overdue) ? 'Shot reminder' : 'Shot day',
              body: items.map(i => `${i.name}: ${i.text}${i.overdue ? ' (overdue)' : ''}`).join(' · '),
              tag: `due-${today}`,
            });
          }
        }
        if (st.weeklyEmail?.enabled && d.getDay() === st.weeklyEmail.day && time >= st.weeklyEmail.time && sent.weekly !== today && user.email && mail.configured()) {
          sent.weekly = today; changed = true;
          await sendSummary(user, profile, now);
        }
        const month = today.slice(0, 7);
        if (st.monthlyExport?.enabled && d.getDate() === 1 && time >= '07:00' && sent.export !== month && user.email && mail.configured()) {
          sent.export = month; changed = true;
          await sendExport(user, profile);
        }
      } catch (e) { log.error(`[jobs] ${user.user}: ${e.message}`); }
    }
    if (changed) store.write(db);
  }
  if (scheduler) setInterval(() => tick().catch(e => log.error('[jobs]', e.message)), 60000).unref();

  const handler = async function handler(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return send(res, 400, { error: 'Bad URL' });
    }
    try {
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      send(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'Server error' });
    }
  };
  handler.tick = tick; // for tests
  return handler;
}
