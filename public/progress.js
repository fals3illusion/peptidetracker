// Progress stats and smoothing. Shared by the browser and the tests.
const DAY = 86400000;

// Average of the weigh-ins in the 7 days up to and including each one.
export function movingAverage(entries, days = 7) {
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  let start = 0, sum = 0;
  return sorted.map((e, i) => {
    sum += e.weight;
    while (sorted[start].t <= e.t - days * DAY) sum -= sorted[start++].weight;
    return { t: e.t, avg: sum / (i - start + 1) };
  });
}

export const MILESTONES = [5, 10, 15, 20, 25, 30];

export function bmi(weightLb, heightIn) {
  return heightIn > 0 ? (703 * weightLb) / (heightIn * heightIn) : null;
}
export function bmiCategory(b) {
  if (b == null) return null;
  if (b < 18.5) return 'Underweight';
  if (b < 25) return 'Healthy';
  if (b < 30) return 'Overweight';
  return 'Obese';
}

export function progress(entries, heightIn = null) {
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  if (!sorted.length) return null;
  const start = sorted[0], current = sorted[sorted.length - 1];
  const lowest = sorted.reduce((m, e) => (e.weight < m.weight ? e : m), start);
  const lost = start.weight - current.weight;
  const milestones = MILESTONES.map(pct => {
    const target = start.weight * (1 - pct / 100);
    const hit = sorted.find(e => e.weight <= target);
    return { pct, target, date: hit ? hit.t : null };
  });
  const b = bmi(current.weight, heightIn);
  return {
    start, current, lowest, lost,
    pctLost: (lost / start.weight) * 100,
    milestones,
    next: milestones.find(m => !m.date) || null,
    bmi: b, bmiCategory: bmiCategory(b),
    startBmi: bmi(start.weight, heightIn),
  };
}
