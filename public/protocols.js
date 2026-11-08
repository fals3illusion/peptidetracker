// Schedules ("protocols") for medications other than the main GLP-1, e.g. peptides.
// Shared by the browser and the tests.
//
// protocol: {
//   name                    medication name (matches vials/shots, any case)
//   freq: 'daily' | 'days' | 'every' | 'asneeded'
//   days: [0..6]            for 'days' (0 = Sunday)
//   everyN                  for 'every' (every N days)
//   start                   ms; shots before this are ignored for dose increases
//   unit: 'units' | 'mg'    what the dose is measured in
//   amount                  starting dose in that unit
//   titrate: { enabled, step, every, max }   increase by `step` after every `every` doses, up to `max`
// }
const DAY = 86400000;
const round = v => Math.round(v * 1000) / 1000;
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY); // calendar days, DST-safe

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function protocolFor(protocols, name) {
  return (protocols || []).find(p => sameName(p.name, name)) || null;
}
// Main GLP-1 shots: anything without its own schedule.
export const mainShots = (shots, protocols) => shots.filter(s => !protocolFor(protocols, s.name));
export const shotsOf = (shots, name) => shots.filter(s => sameName(s.name, name));

// The dose to take next, in the protocol's unit.
export function protocolDose(p, shots) {
  const taken = shotsOf(shots, p.name).filter(s => p.start == null || s.t >= p.start).length;
  const t = p.titrate || {};
  if (!t.enabled || !(t.step > 0) || !(t.every > 0)) return { amount: p.amount, taken, stepUp: false };
  const cap = v => (t.max > 0 ? Math.min(v, t.max) : v);
  const at = n => cap(round(p.amount + Math.floor(n / t.every) * t.step)); // dose after n doses taken
  const amount = at(taken);
  const stepUp = taken > 0 && amount > at(taken - 1);
  const atMax = t.max > 0 && amount >= t.max;
  return { amount, taken, stepUp, atMax, untilIncrease: atMax ? null : t.every - (taken % t.every) };
}

// Is it due today? -> { state: 'due-today' | 'done-today' | 'overdue' | 'not-today' | 'as-needed', due }
export function protocolStatus(p, shots, now) {
  const mine = shotsOf(shots, p.name);
  const last = mine.length ? Math.max(...mine.map(s => s.t)) : null;
  const today = startOfDay(now);
  if (p.freq === 'asneeded') return { state: last != null && last >= today ? 'done-today' : 'as-needed', due: null };
  if (last != null && last >= today) return { state: 'done-today', due: null };
  if (p.start != null && startOfDay(p.start) > today) return { state: 'not-today', due: startOfDay(p.start) };
  if (p.freq === 'daily') return { state: 'due-today', due: today };
  if (p.freq === 'days') {
    const days = p.days || [];
    if (days.includes(new Date(now).getDay())) return { state: 'due-today', due: today };
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      if (days.includes(d.getDay())) return { state: 'not-today', due: d.getTime() };
    }
    return { state: 'not-today', due: null };
  }
  if (p.freq === 'every') {
    const n = Math.max(1, p.everyN || 1);
    const from = last != null ? last : (p.start ?? now);
    const due = new Date(startOfDay(from));
    if (last != null) due.setDate(due.getDate() + n);
    const dueT = due.getTime();
    if (dueT === today) return { state: 'due-today', due: dueT };
    if (dueT < today) return { state: 'overdue', due: dueT, daysLate: daysBetween(dueT, today) };
    return { state: 'not-today', due: dueT };
  }
  return { state: 'as-needed', due: null };
}

// Human description, e.g. "Every day · 10 units, +2 units every 7 doses (max 20)"
export function describeProtocol(p, fmtAmount) {
  const when = p.freq === 'daily' ? 'Every day'
    : p.freq === 'days' ? (p.days?.length ? (p.days.length === 7 ? 'Every day' : [...p.days].sort().map(d => WEEKDAYS_SHORT[d]).join(', ')) : 'No days picked')
    : p.freq === 'every' ? (p.everyN === 1 ? 'Every day' : `Every ${p.everyN} days`)
    : 'As needed';
  let dose = fmtAmount(p.amount, p.unit);
  const t = p.titrate || {};
  if (t.enabled && t.step > 0) dose += `, +${fmtAmount(t.step, p.unit)} every ${t.every} dose${t.every === 1 ? '' : 's'}${t.max > 0 ? ` (max ${fmtAmount(t.max, p.unit)})` : ''}`;
  return `${when} · ${dose}`;
}

// One dose can be drawn from two vials (e.g. finishing one and starting the next).
// Those parts are separate shots (so each vial is charged correctly) but count as a
// single dose everywhere else. Parts belong together when they share a groupId, or
// are the same medication track logged in the same minute.
export function trackKey(protocols, name) {
  const p = protocolFor(protocols, name);
  return p ? `p:${p.name.trim().toLowerCase()}` : 'main';
}
export function combineShots(shots, protocols) {
  const groups = new Map();
  for (const s of [...shots].sort((a, b) => a.t - b.t)) {
    const key = s.groupId ? `g:${s.groupId}` : `${trackKey(protocols, s.name)}|${Math.floor(s.t / 60000)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.values()].map(parts => {
    if (parts.length === 1) return parts[0];
    const r = v => Math.round(v * 1000) / 1000;
    const allUnits = parts.every(p => p.units != null);
    return {
      ...parts[0],
      doseMg: r(parts.reduce((n, p) => n + (p.doseMg || 0), 0)),
      units: allUnits ? r(parts.reduce((n, p) => n + p.units, 0)) : null,
      parts,
    };
  }).sort((a, b) => a.t - b.t);
}
