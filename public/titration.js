// Dose plan ("titration"): step the dose up after a set number of shots at each dose,
// never past a maximum. Counting shots (not calendar weeks) means a late or skipped week
// doesn't push you up early. Shared by the browser and the tests.
//
// plan: { enabled, start, startDose, step, every, maxDose }
//   start      ignore shots before this time (e.g. restarting after a break)
//   startDose  first dose when there are no shots since `start`
//   step       mg added at each increase (usually 2.5)
//   every      shots at each dose before increasing (usually 4 = weekly for 4 weeks)
//   maxDose    never recommend more than this

const DAY = 86400000;
export const DEFAULT_PLAN = { enabled: false, start: null, startDose: 2.5, step: 2.5, every: 4, maxDose: 15 };
// Add calendar days (not 24h blocks), so dates don't slip across daylight-saving changes.
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const round = v => Math.round(v * 1000) / 1000; // avoid 7.499999 from float math

const planOf = p => ({ ...DEFAULT_PLAN, ...(p || {}) });
// A dose close to a step of the plan counts as that step (e.g. 9 mg when you meant 10 mg,
// or 4 + 5 mg drawn from two vials), so one slightly-off shot doesn't start a new "step".
function snapToPlan(mg, plan) {
  if (!(plan.step > 0) || mg == null) return mg;
  const k = Math.max(0, Math.round((mg - plan.startDose) / plan.step));
  const grid = Math.min(round(plan.startDose + k * plan.step), plan.maxDose);
  return Math.abs(mg - grid) <= plan.step * 0.4 + 1e-9 ? grid : mg;
}
const relevant = (shots, plan) => [...shots]
  .filter(s => plan.start == null || s.t >= plan.start)
  .map(s => ({ ...s, doseMg: snapToPlan(s.doseMg, plan), loggedMg: s.doseMg }))
  .sort((a, b) => a.t - b.t);

// Consecutive shots at the most recent dose (any brand: Zepbound 5 then Tirzepatide 5 count together).
function runAtLastDose(sorted) {
  if (!sorted.length) return { dose: null, count: 0 };
  const dose = sorted[sorted.length - 1].doseMg;
  let count = 0;
  for (let i = sorted.length - 1; i >= 0 && sorted[i].doseMg === dose; i--) count++;
  return { dose, count };
}

// What to take next, and why.
export function recommendDose(shots, planIn, now = Date.now()) {
  const plan = planOf(planIn);
  const sorted = relevant(shots, plan);
  if (!sorted.length) {
    const doseMg = Math.min(plan.startDose, plan.maxDose);
    return { doseMg, stepUp: false, count: 0, reason: `Starting dose for your plan`, warning: null };
  }
  const { dose, count } = runAtLastDose(sorted);
  const last = sorted[sorted.length - 1];
  const weeksSince = (now - last.t) / (7 * DAY);
  const warning = weeksSince >= 2
    ? `It's been ${Math.floor(weeksSince)} weeks since your last shot. Check with your prescriber before taking a higher dose.`
    : null;

  if (dose >= plan.maxDose) {
    return { doseMg: plan.maxDose, stepUp: false, count, atMax: true, reason: `You're at your max dose (${plan.maxDose} mg)`, warning };
  }
  if (count >= plan.every) {
    const next = round(Math.min(dose + plan.step, plan.maxDose));
    return { doseMg: next, stepUp: true, count, from: dose, reason: `${count} shots at ${dose} mg done — time to step up to ${next} mg`, warning };
  }
  const left = plan.every - count;
  return { doseMg: dose, stepUp: false, count, reason: `Shot ${count + 1} of ${plan.every} at ${dose} mg (${left === 1 ? 'last one before' : `${left} more before`} stepping up)`, warning };
}

// The whole plan: past doses from your shots, then projected future steps.
// nextShotAt: when the next shot is due (from the shot-day setting).
export function dosePlan(shots, planIn, nextShotAt) {
  const plan = planOf(planIn);
  const sorted = relevant(shots, plan);
  const steps = [];
  for (const s of sorted) {
    const cur = steps[steps.length - 1];
    if (cur && cur.doseMg === s.doseMg) { cur.shots++; cur.lastAt = s.t; }
    else steps.push({ doseMg: s.doseMg, startAt: s.t, lastAt: s.t, shots: 1, status: 'done' });
  }
  const rec = recommendDose(shots, plan, nextShotAt ?? Date.now());
  let t = nextShotAt ?? (sorted.length ? addDays(sorted[sorted.length - 1].t, 7) : plan.start ?? Date.now());

  if (steps.length) {
    const cur = steps[steps.length - 1];
    if (rec.stepUp) {
      cur.status = 'done';
    } else {
      cur.status = 'current';
      cur.remaining = Math.max(0, plan.every - cur.shots);
      // Remaining shots at this dose come first.
      t = addDays(t, cur.remaining * 7);
    }
  }
  // Future steps until the max dose.
  let dose = steps.length ? (rec.stepUp ? rec.doseMg : round(steps[steps.length - 1].doseMg + plan.step)) : rec.doseMg;
  const last = steps[steps.length - 1];
  if (last && last.doseMg >= plan.maxDose) return { plan, steps, rec };
  let first = true;
  while (dose <= plan.maxDose + 1e-9) {
    steps.push({ doseMg: round(dose), startAt: t, shots: 0, status: first ? 'next' : 'planned' });
    first = false;
    t = addDays(t, plan.every * 7);
    dose = round(dose + plan.step);
    if (steps.length > 40) break;
  }
  return { plan, steps, rec };
}
