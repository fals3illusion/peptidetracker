// Vial / pen tracking and shot math. Shared by the browser and the tests.
//
// supply: { id, name, kind: 'vial'|'pack', mg?, waterMl?, count?, price?, opened, done, note }
//   vial = powder you mix with water (mg + waterMl)
//   pack = pre-filled pens / single-dose vials (count doses per purchase)
// shot:   { id, t, supplyId?, name, doseMg, units?, note }
//
// Units are for a U-100 insulin syringe: 100 units = 1 mL.

const pos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const DAY = 86400000;

export function concentration(supply) {
  return supply && supply.kind === 'vial' && pos(supply.mg) && pos(supply.waterMl) ? supply.mg / supply.waterMl : null;
}
export const mgToUnits = (mg, conc) => (pos(conc) ? (mg / conc) * 100 : null);
// Syringes only have marks every 1 unit (or ½ / 2): round a calculated amount to the nearest mark.
export function roundUnits(u, step = 1) {
  if (u == null || !Number.isFinite(u)) return u;
  const s = step > 0 ? step : 1;
  return Math.round(Math.round(u / s + 1e-9) * s * 100) / 100;
}
export const unitsToMg = (units, conc) => (pos(conc) ? (units / 100) * conc : null);

// What's been used and what's left in a supply.
export function usage(supply, shots) {
  const mine = shots.filter(s => s.supplyId === supply.id);
  const out = { shots: mine.length };
  if (supply.kind === 'pack') {
    if (pos(supply.count)) {
      out.left = Math.max(0, supply.count - mine.length);
      out.fraction = out.left / supply.count;
    }
    return out;
  }
  const conc = concentration(supply);
  const usedMg = mine.reduce((sum, s) => sum + (pos(s.doseMg) ? s.doseMg : 0), 0);
  out.usedMg = usedMg;
  if (pos(supply.mg)) {
    // adjustMg: your correction after checking what's really left (see the vial screen).
    out.leftMg = Math.min(supply.mg, Math.max(0, supply.mg - usedMg + (Number(supply.adjustMg) || 0)));
    out.fraction = out.leftMg / supply.mg;
  }
  if (conc) {
    out.leftMl = out.leftMg / conc;
    out.leftUnits = out.leftMl * 100;
  }
  // Shots left at the most recent dose from this vial.
  const last = [...mine].sort((a, b) => b.t - a.t)[0];
  if (last && pos(last.doseMg) && out.leftMg != null) {
    out.atDoseMg = last.doseMg;
    // Within 2% of a dose still counts as one (49.5 units left of a 50-unit dose).
    out.shotsLeft = Math.floor(out.leftMg / last.doseMg + 0.02);
  }
  return out;
}

// Cost of one shot: share of the vial's price by mg, or price / pens in the box.
export function shotCost(shot, supply) {
  if (!supply || !pos(supply.price)) return null;
  if (supply.kind === 'pack') return pos(supply.count) ? supply.price / supply.count : null;
  if (pos(supply.mg) && pos(shot.doseMg)) return supply.price * (shot.doseMg / supply.mg);
  return null;
}

export const totalSpent = supplies => supplies.reduce((sum, s) => sum + (pos(s.price) ? s.price : 0), 0);

// The shot in effect at time t (latest at or before t).
export function shotAt(shots, t) {
  let best = null;
  for (const s of shots) if (s.t <= t && (!best || s.t > best.t)) best = s;
  return best;
}

// Shots where the medication or dose changed from the one before.
export function doseChanges(shots) {
  const sorted = [...shots].sort((a, b) => a.t - b.t);
  return sorted.filter((s, i) => {
    const prev = sorted[i - 1];
    return !prev || prev.doseMg !== s.doseMg || prev.name.toLowerCase() !== s.name.toLowerCase();
  });
}

// Typical gap between shots (median of recent gaps), defaulting to weekly.
export function nextShotDue(shots) {
  const sorted = [...shots].sort((a, b) => a.t - b.t);
  if (!sorted.length) return null;
  const gaps = sorted.slice(-6).map((s, i, a) => (i ? s.t - a[i - 1].t : null)).filter(Boolean).sort((a, b) => a - b);
  let gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 7 * DAY;
  if (gap < DAY) gap = 7 * DAY;
  return sorted[sorted.length - 1].t + Math.round(gap / DAY) * DAY;
}

// ---- Injection sites ----
export const SITES = ['Stomach – left', 'Stomach – right', 'Thigh – left', 'Thigh – right', 'Arm – left', 'Arm – right'];

// Next site in your rotation after the most recent shot that recorded one.
// `rotation` is the list of sites you use (in order); defaults to all of them.
export function suggestSite(shots, rotation = SITES) {
  const sites = rotation && rotation.length ? rotation : SITES;
  const last = [...shots].sort((a, b) => b.t - a.t).find(s => s.site);
  if (!last) return sites[0];
  const i = sites.indexOf(last.site);
  if (i === -1) {
    // Last site isn't in the rotation any more: continue from the next one after it overall.
    const after = SITES.slice(SITES.indexOf(last.site) + 1).find(x => sites.includes(x));
    return after || sites[0];
  }
  return sites[(i + 1) % sites.length];
}

// ---- Shot day ----
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// shotDay: 0 = Sunday … 6 = Saturday (local time), or null to guess from history.
// Returns { state: 'due-today' | 'overdue' | 'done-today' | 'upcoming', due }.
export function shotStatus(shots, shotDay, now) {
  const today = startOfDay(now);
  const last = shots.length ? Math.max(...shots.map(s => s.t)) : null;
  if (last != null && last >= today) return { state: 'done-today', due: null };
  let due;
  if (shotDay == null) {
    if (last == null) return { state: 'upcoming', due: null };
    due = startOfDay(nextShotDue(shots));
  } else {
    // Most recent shot day on or before today.
    const d = new Date(today);
    d.setDate(d.getDate() - ((d.getDay() - shotDay + 7) % 7));
    const recent = d.getTime();
    if (last != null && last >= recent) {
      // Already taken this cycle: next one is a week later.
      const n = new Date(recent); n.setDate(n.getDate() + 7);
      return { state: 'upcoming', due: n.getTime() };
    }
    due = recent;
  }
  if (due === today) return { state: 'due-today', due };
  if (due < today) return { state: 'overdue', due };
  return { state: 'upcoming', due };
}

// Open vials/boxes that are down to `refillAt` doses or fewer.
export function refillAlerts(supplies, shots, refillAt) {
  const out = [];
  for (const s of supplies) {
    if (s.done) continue;
    const u = usage(s, shots);
    const left = s.kind === 'pack' ? u.left : u.shotsLeft;
    if (left != null && left <= refillAt) out.push({ supply: s, left });
  }
  return out;
}

// Doses taken from one vial/box, grouped by dose in the order you took them.
// e.g. { count: 6, byDose: [{ doseMg: 5, count: 1 }, { doseMg: 7.5, count: 4 }, { doseMg: 10, count: 1 }] }
export function takenFrom(supply, shots) {
  const mine = shots.filter(s => s.supplyId === supply.id).sort((a, b) => a.t - b.t);
  const byDose = [];
  for (const s of mine) {
    const g = byDose.find(x => x.doseMg === s.doseMg);
    if (g) g.count++; else byDose.push({ doseMg: s.doseMg, count: 1 });
  }
  return { count: mine.length, byDose };
}
