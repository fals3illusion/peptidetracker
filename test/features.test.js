import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITES, suggestSite, shotStatus, refillAlerts } from '../public/supplies.js';
import { movingAverage, progress, bmi } from '../public/progress.js';

const DAY = 86400000;
const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const THU = 4;

test('site rotation', () => {
  assert.equal(suggestSite([]), SITES[0]);
  assert.equal(suggestSite([{ t: 1, site: SITES[0] }]), SITES[1]);
  assert.equal(suggestSite([{ t: 1, site: SITES[5] }]), SITES[0]);
  // Uses the latest shot that has a site; ignores older ones and shots without.
  assert.equal(suggestSite([{ t: 1, site: SITES[2] }, { t: 2, site: SITES[3] }, { t: 3 }]), SITES[4]);
});

test('site rotation: stomach left/right only', () => {
  const rot = ['Stomach – left', 'Stomach – right'];
  assert.equal(suggestSite([], rot), 'Stomach – left');
  assert.equal(suggestSite([{ t: 1, site: 'Stomach – left' }], rot), 'Stomach – right');
  assert.equal(suggestSite([{ t: 1, site: 'Stomach – right' }], rot), 'Stomach – left');
  // A site outside the rotation (e.g. once in the thigh) -> back into the rotation
  assert.equal(suggestSite([{ t: 1, site: 'Thigh – left' }], rot), 'Stomach – left');
  assert.equal(suggestSite([{ t: 1, site: 'Stomach – left' }], []), 'Stomach – right', 'empty rotation = all sites');
});

test('shot day: Thursday schedule', () => {
  const shots = [{ t: local(2026, 10, 15) }]; // Thu Oct 15
  // Tue Oct 20 -> upcoming Thu Oct 22
  let s = shotStatus(shots, THU, local(2026, 10, 20, 6));
  assert.equal(s.state, 'upcoming');
  assert.equal(new Date(s.due).getDate(), 22);
  // Thu Oct 22 morning, not taken yet -> due today
  assert.equal(shotStatus(shots, THU, local(2026, 10, 22, 6)).state, 'due-today');
  // Fri Oct 23, still not taken -> overdue
  s = shotStatus(shots, THU, local(2026, 10, 23, 6));
  assert.equal(s.state, 'overdue');
  assert.equal(new Date(s.due).getDate(), 22);
  // Taken Thursday -> done today, then upcoming next week
  const taken = [...shots, { t: local(2026, 10, 22, 7) }];
  assert.equal(shotStatus(taken, THU, local(2026, 10, 22, 9)).state, 'done-today');
  s = shotStatus(taken, THU, local(2026, 10, 24, 9));
  assert.equal(s.state, 'upcoming');
  assert.equal(new Date(s.due).getDate(), 29);
});

test('shot day: no setting falls back to history', () => {
  assert.equal(shotStatus([], null, Date.now()).state, 'upcoming');
  const shots = [{ t: local(2026, 10, 8) }, { t: local(2026, 10, 15) }];
  assert.equal(shotStatus(shots, null, local(2026, 10, 22, 6)).state, 'due-today');
});

test('refill alerts at threshold', () => {
  const vial = { id: 'v', kind: 'vial', mg: 60, waterMl: 3, done: false };
  const shots = [5, 7.5, 7.5, 7.5, 7.5].map((d, i) => ({ supplyId: 'v', doseMg: d, t: i }));
  // 25 mg left = 3 × 7.5
  assert.equal(refillAlerts([vial], shots, 3).length, 1);
  assert.equal(refillAlerts([vial], shots, 3)[0].left, 3);
  assert.equal(refillAlerts([vial], shots, 2).length, 0);
  assert.equal(refillAlerts([{ ...vial, done: true }], shots, 3).length, 0);
  const pack = { id: 'p', kind: 'pack', count: 4 };
  assert.equal(refillAlerts([pack], [{ supplyId: 'p', t: 1, doseMg: 2.5 }, { supplyId: 'p', t: 2, doseMg: 2.5 }], 2)[0].left, 2);
});

test('7-day moving average', () => {
  const e = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(d => ({ t: d * DAY, weight: 100 - d }));
  const avg = movingAverage(e);
  assert.equal(avg[0].avg, 100);
  assert.equal(avg[6].avg, 97);          // days 0..6
  assert.equal(avg[8].avg, 95);          // days 2..8 -> 98..92, mean 95
});

test('progress and milestones', () => {
  const e = [{ t: 1, weight: 250 }, { t: 2, weight: 237 }, { t: 3, weight: 224 }, { t: 4, weight: 211.8 }, { t: 5, weight: 213 }];
  const p = progress(e, 70);
  assert.equal(p.lost, 37);
  assert.ok(Math.abs(p.pctLost - 14.8) < 1e-9);
  assert.deepEqual(p.milestones.slice(0, 4).map(m => m.date), [2, 3, 4, null]); // 5% ≤237.5, 10% ≤225, 15% ≤212.5, 20% not yet
  assert.equal(p.next.pct, 20);
  assert.equal(p.lowest.weight, 211.8);
  assert.ok(Math.abs(p.bmi - 703 * 213 / 4900) < 1e-9);
  assert.equal(p.bmiCategory, 'Obese');
  assert.equal(bmi(200, null), null);
  assert.equal(progress([], 70), null);
});
