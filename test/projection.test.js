import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, fitLine, requiredPace } from '../public/projection.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);
const series = (n, start, perDay, step = 1) =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * step * DAY, weight: start + perDay * i * step }));

test('fitLine recovers a straight line', () => {
  const f = fitLine([{ x: 0, y: 10 }, { x: 1, y: 8 }, { x: 2, y: 6 }]);
  assert.ok(Math.abs(f.slope + 2) < 1e-9);
  assert.ok(Math.abs(f.intercept - 10) < 1e-9);
});

test('needs at least 2 entries over 3 days', () => {
  assert.equal(project([], 180).status, 'insufficient');
  assert.equal(project(series(1, 200, -0.2), 180).status, 'insufficient');
  assert.equal(project(series(2, 200, -0.2), 180).status, 'insufficient'); // only 1 day apart
  assert.equal(project(series(5, 200, -0.2), 180).status, 'ok');
});

test('steady loss projects the right date', () => {
  // 200 lb losing 0.5 lb/day for 10 days -> 195.5 on day 9; goal 180 is 31 days later
  const r = project(series(10, 200, -0.5), 180);
  assert.equal(r.recent.status, 'ok');
  assert.ok(Math.abs(r.recent.perWeek + 3.5) < 1e-6);
  assert.ok(Math.abs(r.recent.days - 31) < 1e-6);
  assert.equal(r.recent.date, T0 + 40 * DAY);
  assert.ok(Math.abs(r.overall.days - 31) < 1e-6);
});

test('recent trend favors new data when pace slows', () => {
  // Fast loss early, slower loss lately (common on GLP-1)
  const fast = series(30, 220, -0.4);
  const lastFast = fast[fast.length - 1];
  const slow = Array.from({ length: 30 }, (_, i) => ({ t: lastFast.t + (i + 1) * DAY, weight: lastFast.weight - 0.1 * (i + 1) }));
  const r = project([...fast, ...slow], 180);
  assert.ok(Math.abs(r.recent.perWeek) < Math.abs(r.overall.perWeek), 'recent pace is slower');
  assert.ok(r.recent.date > r.overall.date, 'recent projection is later');
});

test('gaining while trying to lose -> wrong-direction', () => {
  assert.equal(project(series(10, 200, 0.3), 180).recent.status, 'wrong-direction');
});

test('goal already reached', () => {
  assert.equal(project(series(10, 200, -1), 195).recent.status, 'reached');
});

test('no goal still reports pace', () => {
  const r = project(series(10, 200, -0.5), null);
  assert.equal(r.recent.status, 'no-goal');
  assert.ok(Math.abs(r.recent.perWeek + 3.5) < 1e-6);
});

test('gain goal works too', () => {
  const r = project(series(10, 120, 0.2), 130);
  assert.equal(r.recent.status, 'ok');
});

test('entry order does not matter', () => {
  const s = series(10, 200, -0.5);
  assert.deepEqual(project([...s].reverse(), 180), project(s, 180));
});

test('requiredPace', () => {
  assert.equal(requiredPace(200, 180, T0 + 70 * DAY, T0), -2);
  assert.equal(requiredPace(200, 180, T0 - DAY, T0), null);
});
