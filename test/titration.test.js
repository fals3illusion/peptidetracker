import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendDose, dosePlan } from '../public/titration.js';

const DAY = 86400000;
const d = (m, day) => new Date(2026, m - 1, day, 12).getTime();
const plan = { enabled: true, start: d(7, 23), startDose: 2.5, step: 2.5, every: 4, maxDose: 15 };

// The real history: 4 × 2.5, 4 × Zepbound 5 + 1 × Tirzepatide 5, then 4 × 7.5
const history = [
  ...[[7, 23], [7, 30], [8, 6], [8, 13]].map(([m, x]) => ({ t: d(m, x), name: 'Zepbound', doseMg: 2.5 })),
  ...[[8, 21], [8, 28], [9, 4], [9, 11]].map(([m, x]) => ({ t: d(m, x), name: 'Zepbound', doseMg: 5 })),
  { t: d(9, 17), name: 'Tirzepatide', doseMg: 5 },
  ...[[9, 24], [10, 1], [10, 8], [10, 15]].map(([m, x]) => ({ t: d(m, x), name: 'Tirzepatide', doseMg: 7.5 })),
];

test('no shots yet -> starting dose', () => {
  const r = recommendDose([], plan, d(7, 23));
  assert.equal(r.doseMg, 2.5);
  assert.equal(r.stepUp, false);
});

test('mid-step -> same dose, counts shots', () => {
  const r = recommendDose(history.slice(0, 2), plan, d(8, 6));
  assert.equal(r.doseMg, 2.5);
  assert.equal(r.count, 2);
  assert.match(r.reason, /Shot 3 of 4/);
});

test('after 4 shots at 7.5 -> step up to 10', () => {
  const r = recommendDose(history, plan, d(10, 22));
  assert.equal(r.doseMg, 10);
  assert.equal(r.stepUp, true);
  assert.equal(r.from, 7.5);
  assert.equal(r.warning, null);
});

test('brand switch at the same dose still counts as the same step', () => {
  // 4 Zepbound 5 + 1 Tirzepatide 5 = 5 shots at 5 mg -> step up
  const r = recommendDose(history.slice(0, 9), plan, d(9, 24));
  assert.equal(r.doseMg, 7.5);
  assert.equal(r.count, 5);
});

test('never above max; holding at max', () => {
  assert.equal(recommendDose(history, { ...plan, maxDose: 7.5 }, d(10, 22)).doseMg, 7.5);
  assert.equal(recommendDose(history, { ...plan, maxDose: 7.5 }, d(10, 22)).atMax, true);
  assert.equal(recommendDose(history, { ...plan, maxDose: 9 }, d(10, 22)).doseMg, 9);
});

test('long gap adds a warning', () => {
  const r = recommendDose(history, plan, d(11, 5));
  assert.match(r.warning, /3 weeks/);
});

test('plan start ignores earlier shots (restart after a break)', () => {
  const r = recommendDose(history, { ...plan, start: d(10, 20), startDose: 5 }, d(10, 22));
  assert.equal(r.doseMg, 5);
  assert.equal(r.count, 0);
});

test('custom steps: 5 mg increases every 2 shots', () => {
  const r = recommendDose(history.slice(0, 2), { ...plan, step: 5, every: 2 }, d(8, 6));
  assert.equal(r.doseMg, 7.5);
});

test('full plan: history then projected steps to the max', () => {
  const p = dosePlan(history, plan, d(10, 22));
  assert.deepEqual(p.steps.map(s => [s.doseMg, s.shots, s.status]), [
    [2.5, 4, 'done'], [5, 5, 'done'], [7.5, 4, 'done'],
    [10, 0, 'next'], [12.5, 0, 'planned'], [15, 0, 'planned'],
  ]);
  assert.equal(p.steps[3].startAt, d(10, 22));
  assert.equal(p.steps[4].startAt, d(11, 19), 'still Thursday after DST ends Nov 1');
  assert.equal(p.steps[5].startAt, d(12, 17));
});

test('plan while mid-step: remaining shots push the next step out', () => {
  const p = dosePlan(history.slice(0, 11), plan, d(10, 8)); // 2 shots at 7.5 done
  const cur = p.steps.find(s => s.status === 'current');
  assert.equal(cur.doseMg, 7.5);
  assert.equal(cur.remaining, 2);
  const next = p.steps.find(s => s.status === 'next');
  assert.equal(next.doseMg, 10);
  assert.equal(next.startAt, d(10, 22));
});

test('plan at max has no future steps', () => {
  const p = dosePlan(history, { ...plan, maxDose: 7.5 }, d(10, 22));
  assert.equal(p.steps.at(-1).doseMg, 7.5);
  assert.ok(!p.steps.some(s => s.status === 'next'));
});

test('a dose close to a plan step counts as that step', () => {
  const near = [...history.slice(0, 13), { t: d(10, 22), name: 'Tirzepatide', doseMg: 10 }, { t: d(10, 29), name: 'Tirzepatide', doseMg: 9 }];
  const r = recommendDose(near, plan, d(11, 5));
  assert.equal(r.doseMg, 10, '9 mg counts toward the 10 mg step');
  assert.equal(r.count, 2);
  const p2 = dosePlan(near, plan, d(11, 5));
  assert.deepEqual(p2.steps.filter(s => s.status !== 'done').map(s => s.doseMg), [10, 12.5, 15]);
  // Far from any step: kept as logged
  const odd = [...history.slice(0, 13), { t: d(10, 22), name: 'Tirzepatide', doseMg: 8.75 }];
  assert.equal(recommendDose(odd, plan, d(10, 29)).doseMg, 8.75);
});
