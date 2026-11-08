// Planning helpers shared by the page and the server's scheduled jobs:
// what's due today, use-by dates for mixed vials, when to reorder, and how each dose worked.
// `data` is one person's profile: { entries, supplies, shots, inventory, settings }.
import { concentration, unitsToMg, mgToUnits, usage, shotStatus, nextShotDue, doseChanges } from './supplies.js';
import { protocolFor, mainShots, combineShots, shotsOf, protocolDose, protocolStatus } from './protocols.js';
import { recommendDose } from './titration.js';
import { fitLine } from './projection.js';

const DAY = 86400000;
const lc = n => String(n || '').trim().toLowerCase();
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const r2 = v => Math.round(v * 100) / 100;
export const fmtMg = mg => (mg > 0 && mg < 1 ? `${r2(mg * 1000)} mcg` : `${r2(mg)} mg`);

const protocols = data => data.settings?.protocols || [];
const extras = (data, name) => (data.settings?.medExtras || {})[lc(name)] || {};
const doses = data => combineShots(data.shots || [], protocols(data));
const mainList = data => combineShots(mainShots(data.shots || [], protocols(data)), protocols(data));
const openVials = (data, name) => (data.supplies || []).filter(v => !v.done && lc(v.name) === lc(name));
// Oldest open vial with something left (the one you'd draw from).
function vialInUse(data, name) {
  const open = openVials(data, name).sort((a, b) => a.opened - b.opened);
  return open.find(v => v.kind !== 'vial' || (usage(v, data.shots).leftMg ?? 1) > 1e-6) || open.at(-1) || null;
}

// ---- the next dose of each medication, in mg ----
export function mainDose(data, now = Date.now()) {
  const main = mainList(data);
  if (!main.length) return null;
  const plan = data.settings?.plan;
  const mg = plan?.enabled ? recommendDose(main, plan, now).doseMg : main.at(-1).doseMg;
  return { name: main.at(-1).name, mg };
}
export function protocolDoseMg(data, p) {
  const rec = protocolDose(p, doses(data));
  if (p.unit === 'mg') return { mg: rec.amount, units: null, amount: rec.amount };
  const ref = p.refConc || concentration(vialInUse(data, p.name));
  return { mg: ref ? unitsToMg(rec.amount, ref) : null, amount: rec.amount };
}
// Doses per week from the schedule (as-needed: what you actually took over the last 4 weeks).
export function dosesPerWeek(data, p, now = Date.now()) {
  if (!p) return 1; // main GLP-1: weekly
  if (p.freq === 'daily') return 7;
  if (p.freq === 'days') return (p.days || []).length;
  if (p.freq === 'every') return 7 / Math.max(1, p.everyN || 1);
  return shotsOf(doses(data), p.name).filter(s => s.t > now - 28 * DAY).length / 4;
}

// ---- what's due today (for the morning notification) ----
// Returns [{ key, name, text }]; key is 'main' or the medication name in lower case.
export function dueToday(data, now = Date.now()) {
  const out = [];
  const main = mainList(data);
  if (main.length) {
    const st = shotStatus(main, data.settings?.shotDay ?? null, now);
    if (st.state === 'due-today' || st.state === 'overdue') {
      const d = mainDose(data, now);
      const v = vialInUse(data, d.name), c = concentration(v);
      out.push({ key: 'main', name: d.name, overdue: st.state === 'overdue', text: `${fmtMg(d.mg)}${c ? ` (${r2(mgToUnits(d.mg, c))} units)` : ''}` });
    }
  }
  for (const p of protocols(data)) {
    if (extras(data, p.name).hidden) continue;
    const st = protocolStatus(p, doses(data), now);
    if (st.state !== 'due-today' && st.state !== 'overdue') continue;
    const d = protocolDoseMg(data, p);
    const c = concentration(vialInUse(data, p.name));
    const text = d.mg != null && c ? `${r2(mgToUnits(d.mg, c))} units (${fmtMg(d.mg)})` : p.unit === 'units' ? `${r2(d.amount)} units` : fmtMg(d.amount);
    out.push({ key: lc(p.name), name: p.name, overdue: st.state === 'overdue', text });
  }
  return out;
}

// ---- use-by for mixed vials / cartridges ----
// useWithin (days after mixing) comes from the vial, else the medication's default.
export function useBy(data, supply, now = Date.now()) {
  if (supply.kind !== 'vial' || supply.done) return null;
  const days = supply.useWithin || extras(data, supply.name).useWithin;
  if (!(days > 0)) return null;
  const by = addDays(startOfDay(supply.opened), days);
  const daysLeft = Math.round((by - startOfDay(now)) / DAY);
  const u = usage(supply, data.shots || []);
  const p = protocolFor(protocols(data), supply.name);
  const perWeek = dosesPerWeek(data, p, now);
  // Doses left at the dose you're on now (the plan's next dose), not the vial's last one.
  const doseMg = p ? protocolDoseMg(data, p).mg : mainDose(data, now)?.mg;
  const shotsLeft = doseMg > 0 && u.leftMg != null ? Math.floor(u.leftMg / doseMg + 0.02) : u.shotsLeft;
  // How long what's left lasts at your schedule.
  const finishBy = shotsLeft != null && perWeek > 0 ? addDays(startOfDay(now), Math.ceil(shotsLeft / perWeek * 7)) : null;
  return { by, days, daysLeft, finishBy, wontFinish: finishBy != null && finishBy > by && shotsLeft > 0, shotsLeft };
}

// ---- reorder planner ----
// For each medication you take on a schedule: how much is on hand, when it runs out, when to order.
// leadDays is the default; a medication can set its own (medExtras[name].reorderLead).
export function reorderPlan(data, now = Date.now(), leadDays = 10) {
  const names = new Map();
  const main = mainDose(data, now);
  if (main) names.set('main', { name: main.name, p: null, mg: main.mg });
  for (const p of protocols(data)) {
    if (extras(data, p.name).hidden || p.freq === 'asneeded') continue;
    names.set(lc(p.name), { name: p.name, p, mg: protocolDoseMg(data, p).mg });
  }
  const mainNames = new Set((data.shots || []).filter(s => !protocolFor(protocols(data), s.name)).map(s => lc(s.name)));
  const out = [];
  for (const [key, m] of names) {
    if (!(m.mg > 0)) continue;
    const match = n => (key === 'main' ? mainNames.has(lc(n)) || lc(n) === lc(m.name) : lc(n) === key);
    let stockMg = 0, openMg = 0;
    for (const v of (data.supplies || []).filter(v => !v.done && match(v.name))) {
      const u = usage(v, data.shots || []);
      const left = v.kind === 'vial' ? u.leftMg ?? 0 : (u.left ?? 0) * m.mg;
      openMg += left; stockMg += left;
    }
    const inv = (data.inventory || []).filter(x => x.kind === 'peptide' && match(x.name));
    const invMg = inv.reduce((n, x) => n + (x.qty || 0) * (x.mg || 0), 0);
    stockMg += invMg;
    const perWeek = dosesPerWeek(data, m.p, now) * m.mg;
    const daysLeft = perWeek > 0 ? Math.floor(stockMg / perWeek * 7) : null;
    const runOut = daysLeft != null ? addDays(startOfDay(now), daysLeft) : null;
    const lead = extras(data, m.name).reorderLead ?? leadDays;
    const orderBy = runOut != null ? addDays(runOut, -lead) : null;
    // What the next order costs: inventory price, else the medication default, else the last vial bought.
    const lastVial = [...(data.supplies || [])].filter(v => match(v.name) && v.price != null).sort((a, b) => b.opened - a.opened)[0];
    const price = inv.find(x => x.price != null)?.price ?? extras(data, m.name).price ?? lastVial?.price ?? null;
    out.push({ key, name: m.name, lead, doseMg: m.mg, mgPerWeek: perWeek, openMg, invMg, stockMg, daysLeft, runOut, orderBy, price, orderSoon: orderBy != null && orderBy <= addDays(startOfDay(now), 3) });
  }
  return out.sort((a, b) => (a.runOut ?? Infinity) - (b.runOut ?? Infinity));
}

// ---- dose & results: weight change while on each main dose ----
export function doseResults(data) {
  const main = mainList(data);
  const changes = doseChanges(main);
  const entries = [...(data.entries || [])].sort((a, b) => a.t - b.t);
  return changes.map((c, i) => {
    const end = changes[i + 1]?.t ?? Date.now();
    const shots = main.filter(s => s.t >= c.t && s.t < end).length;
    const pts = entries.filter(e => e.t >= c.t && e.t < end).map(e => ({ x: (e.t - c.t) / DAY, y: e.weight }));
    const span = pts.length ? pts.at(-1).x - pts[0].x : 0;
    const fit = pts.length >= 2 && span >= 3 ? fitLine(pts) : null;
    return { name: c.name, doseMg: c.doseMg, start: c.t, end, weeks: (end - c.t) / (7 * DAY), shots, lbPerWeek: fit ? fit.slope * 7 : null, current: i === changes.length - 1 };
  });
}
