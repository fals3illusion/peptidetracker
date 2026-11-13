import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concentration, mgToUnits, unitsToMg, usage, shotCost, totalSpent, shotAt, doseChanges, nextShotDue } from '../public/supplies.js';

const DAY = 86400000;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const vial = { id: 'v1', name: 'Tirzepatide', kind: 'vial', mg: 60, waterMl: 3, price: 200 };
const shots = [
  { id: 'a', t: 1 * DAY, supplyId: 'v1', name: 'Tirzepatide', doseMg: 5, units: 25 },
  ...[8, 15, 22, 29].map((d, i) => ({ id: `b${i}`, t: d * DAY, supplyId: 'v1', name: 'Tirzepatide', doseMg: 7.5, units: 37.5 })),
];

test('60 mg in 3 mL = 20 mg/mL; 7.5 mg = 37.5 units; 5 mg = 25 units', () => {
  close(concentration(vial), 20);
  close(mgToUnits(7.5, 20), 37.5);
  close(mgToUnits(5, 20), 25);
  close(unitsToMg(37.5, 20), 7.5);
  assert.equal(concentration({ kind: 'pack', count: 4 }), null);
  assert.equal(mgToUnits(5, null), null);
});

test('vial usage subtracts each shot', () => {
  const u = usage(vial, shots);
  assert.equal(u.shots, 5);
  close(u.usedMg, 35);
  close(u.leftMg, 25);
  close(u.leftMl, 1.25);
  close(u.leftUnits, 125);
  assert.equal(u.shotsLeft, 3); // 3 × 7.5 = 22.5, 2.5 mg spare
  close(u.fraction, 25 / 60);
});

test('vial never goes negative', () => {
  const u = usage({ ...vial, mg: 10 }, shots);
  assert.equal(u.leftMg, 0);
  assert.equal(u.shotsLeft, 0);
});

test('pack usage counts pens', () => {
  const pack = { id: 'p', kind: 'pack', count: 4, price: 311 };
  const u = usage(pack, [{ supplyId: 'p', t: 1, doseMg: 2.5 }, { supplyId: 'p', t: 2, doseMg: 2.5 }]);
  assert.equal(u.left, 2);
  close(u.fraction, 0.5);
});

test('shot cost', () => {
  close(shotCost({ doseMg: 7.5 }, vial), 25);  // 7.5/60 of $200
  close(shotCost({ doseMg: 5 }, vial), 200 / 12);
  close(shotCost({ doseMg: 2.5 }, { kind: 'pack', count: 4, price: 311 }), 77.75);
  assert.equal(shotCost({ doseMg: 5 }, { kind: 'vial', mg: 60 }), null);
  assert.equal(shotCost({ doseMg: 5 }, null), null);
});

test('total spent sums purchases', () => {
  assert.equal(totalSpent([{ price: 311 }, { price: 412 }, { price: 200 }, {}]), 923);
});

test('shotAt and doseChanges', () => {
  assert.equal(shotAt(shots, 0), null);
  assert.equal(shotAt(shots, 10 * DAY).doseMg, 7.5);
  assert.deepEqual(doseChanges(shots).map(s => s.doseMg), [5, 7.5]);
  // Same dose, different medication counts as a change.
  const mixed = [{ t: 1, name: 'Zepbound', doseMg: 5 }, { t: 2, name: 'Tirzepatide', doseMg: 5 }];
  assert.equal(doseChanges(mixed).length, 2);
});

test('next shot follows the usual gap', () => {
  assert.equal(nextShotDue([]), null);
  assert.equal(nextShotDue(shots), 36 * DAY);
  assert.equal(nextShotDue([{ t: 5 * DAY }]), 12 * DAY); // one shot -> weekly
});

test('takenFrom counts doses from a vial, grouped by dose', async () => {
  const { takenFrom } = await import('../public/supplies.js');
  const more = [...shots, { id: 'z', t: 40 * DAY, supplyId: 'v1', doseMg: 10 }, { id: 'o', t: 41 * DAY, supplyId: 'other', doseMg: 2 }];
  assert.deepEqual(takenFrom(vial, more), { count: 6, byDose: [{ doseMg: 5, count: 1 }, { doseMg: 7.5, count: 4 }, { doseMg: 10, count: 1 }] });
  assert.deepEqual(takenFrom({ id: 'none' }, more), { count: 0, byDose: [] });
});

test('vial correction and near-full last dose', () => {
  const v = { id: 'm', kind: 'vial', mg: 10, waterMl: 3 };
  const sh = [1, 2, 3, 4, 5].map(i => ({ supplyId: 'm', t: i, doseMg: 1.67 }));   // 8.35 used -> 1.65 left
  assert.equal(usage(v, sh).shotsLeft, 1, '1.65 of 1.67 is 98.8%: within 2% counts as a dose');
  const u = usage(v, sh);
  assert.ok(Math.abs(u.leftMg - 1.65) < 1e-9);
  assert.equal(usage(v, [...sh.slice(0, 4), { supplyId: 'm', t: 5, doseMg: 1.7 }]).shotsLeft, 0, '1.62 of 1.7 is 95%: not a dose');
  // You measured 0.6 mL actually left (= 2 mg at 3.33 mg/mL): correction +0.35 mg
  const fixed = usage({ ...v, adjustMg: 0.35 }, sh);
  assert.ok(Math.abs(fixed.leftMl - 0.6) < 1e-9);
  assert.equal(fixed.shotsLeft, 1);
  assert.equal(usage({ ...v, adjustMg: -50 }, sh).leftMg, 0, 'never negative');
  assert.equal(usage({ ...v, adjustMg: 50 }, sh).leftMg, 10, 'never more than the vial held');
});

test('units round to the nearest syringe mark', async () => {
  const { roundUnits } = await import('../public/supplies.js');
  assert.equal(roundUnits(14.58), 15);
  assert.equal(roundUnits(14.49), 14);
  assert.equal(roundUnits(14.5), 15);
  assert.equal(roundUnits(14.58, 0.5), 14.5);
  assert.equal(roundUnits(14.8, 0.5), 15);
  assert.equal(roundUnits(15.2, 2), 16);
  assert.equal(roundUnits(40), 40);
  assert.equal(roundUnits(null), null);
});
