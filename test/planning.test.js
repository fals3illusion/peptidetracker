import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueToday, useBy, reorderPlan, doseResults, dosesPerWeek } from '../public/planning.js';

const DAY = 86400000;
const d = (m, day, h = 12) => new Date(2026, m - 1, day, h).getTime();
const base = () => ({
  entries: [
    { t: d(10, 1), weight: 230 }, { t: d(10, 8), weight: 227 }, { t: d(10, 15), weight: 224 },
    { t: d(10, 22), weight: 222 }, { t: d(10, 29), weight: 219 }, { t: d(11, 5), weight: 216 },
  ],
  supplies: [
    { id: 't', name: 'Tirzepatide', kind: 'vial', mg: 100, waterMl: 4, price: 200, opened: d(11, 5) },
    { id: 'm', name: 'MOTS-C', kind: 'vial', mg: 10, waterMl: 3, price: 30, opened: d(10, 15), useWithin: 28 },
  ],
  shots: [
    ...[[10, 1], [10, 8], [10, 15]].map(([mo, day]) => ({ t: d(mo, day), name: 'Tirzepatide', doseMg: 7.5 })),
    ...[[10, 22], [10, 29], [11, 5]].map(([mo, day]) => ({ t: d(mo, day), name: 'Tirzepatide', doseMg: 10, supplyId: 't' })),
    { t: d(11, 4), name: 'MOTS-C', doseMg: 1.6667, units: 50, supplyId: 'm' },
  ],
  inventory: [{ kind: 'peptide', name: 'MOTS-C', mg: 10, qty: 2, price: 55 }, { kind: 'peptide', name: 'Tirzepatide', mg: 100, qty: 1, price: 200 }],
  settings: {
    shotDay: 4,
    plan: { enabled: true, start: 0, startDose: 2.5, step: 2.5, every: 4, maxDose: 15 },
    protocols: [{ name: 'MOTS-C', freq: 'every', everyN: 3, unit: 'units', amount: 50, refConc: 10 / 3, titrate: { enabled: false } }],
  },
});

test('dosesPerWeek from the schedule', () => {
  const data = base();
  assert.equal(dosesPerWeek(data, null), 1);
  assert.equal(dosesPerWeek(data, { freq: 'daily' }), 7);
  assert.equal(dosesPerWeek(data, { freq: 'days', days: [1, 3, 5] }), 3);
  assert.ok(Math.abs(dosesPerWeek(data, { freq: 'every', everyN: 3 }) - 7 / 3) < 1e-9);
});

test('dueToday: Thursday main shot + MOTS-C every 3 days', () => {
  const data = base();
  const due = dueToday(data, d(11, 12, 7)); // Thu Nov 12; MOTS-C last Nov 4 -> was due Nov 7 (overdue)
  assert.deepEqual(due.map(x => x.key), ['main', 'mots-c']);
  assert.match(due[0].text, /^10 mg \(40 units\)$/);
  assert.equal(due[1].overdue, true);
  assert.match(due[1].text, /^50 units \(1\.67 mg\)$/);
  assert.deepEqual(dueToday(data, d(11, 6, 7)), [], 'nothing due on Fri Nov 6');
});

test('use-by: days left and whether it will be finished in time', () => {
  const data = base();
  const u = useBy(data, data.supplies[1], d(11, 9));
  assert.equal(u.daysLeft, 3);                  // mixed Oct 15 + 28 days = Nov 12
  assert.ok(u.shotsLeft >= 4);                  // ~8.3 mg left / 1.67
  assert.equal(u.wontFinish, true, '4+ doses every 3 days takes ~12 days, past Nov 12');
  assert.equal(useBy(data, data.supplies[0], d(11, 9)), null, 'no use-by set');
  data.settings.medExtras = { tirzepatide: { name: 'Tirzepatide', useWithin: 56 } };
  const t = useBy(data, data.supplies[0], d(11, 9));
  assert.equal(t.daysLeft, 52, 'medication default applies');
  assert.equal(t.shotsLeft, 7, '70 mg left at the planned 10 mg dose');
  assert.equal(t.wontFinish, false, '7 weekly doses fit in 52 days');
});

test('reorder plan: stock, run-out and order-by dates', () => {
  const data = base();
  const plan = reorderPlan(data, d(11, 9), 10);
  const tirz = plan.find(x => x.key === 'main');
  // 3 × 10 mg taken from the 100 mg vial: 70 mg left + 100 mg in stock = 170 mg at 10 mg/week = 119 days
  assert.equal(Math.round(tirz.stockMg), 170);
  assert.equal(tirz.daysLeft, 119);
  assert.equal(tirz.price, 200);
  const mots = plan.find(x => x.key === 'mots-c');
  // ~8.33 mg open + 20 mg stock = 28.33 mg at 1.667 mg x 7/3 per week ≈ 3.89 mg/week -> ~51 days
  assert.ok(mots.daysLeft >= 50 && mots.daysLeft <= 51);
  const back10 = new Date(mots.runOut); back10.setDate(back10.getDate() - 10);
  assert.equal(mots.orderBy, back10.getTime(), 'order 10 days before running out');
  assert.equal(plan[0].key, 'mots-c', 'soonest run-out first');
  // A medication's own lead time beats the default.
  data.settings.medExtras = { 'mots-c': { name: 'MOTS-C', reorderLead: 21 } };
  const own = reorderPlan(data, d(11, 9), 10).find(x => x.key === 'mots-c');
  const back21 = new Date(own.runOut); back21.setDate(back21.getDate() - 21);
  assert.equal(own.orderBy, back21.getTime());
  assert.equal(own.lead, 21);
  assert.equal(reorderPlan(data, d(11, 9), 10).find(x => x.key === 'main').lead, 10);
});

test('dose results: weight change per dose', () => {
  const r = doseResults(base());
  assert.deepEqual(r.map(x => [x.doseMg, x.shots]), [[7.5, 3], [10, 3]]);
  assert.ok(r[0].lbPerWeek < -2.5 && r[0].lbPerWeek > -3.5);
  assert.equal(r[1].current, true);
});

test('due-today text rounds units to the syringe marks and shows the real dose', () => {
  const data = base();
  // A 12 mg vial in 3 mL (4 mg/mL): the 50-unit schedule set on a 3.33 mg/mL vial = 1.667 mg = 41.67 units → 42 units = 1.68 mg
  data.supplies.push({ id: 'm2', name: 'MOTS-C', kind: 'vial', mg: 12, waterMl: 3, opened: d(11, 10) });
  data.supplies.find(v => v.id === 'm').done = true;
  const mots = dueToday(data, d(11, 12, 7)).find(x => x.key === 'mots-c');
  assert.match(mots.text, /^42 units \(1\.68 mg\)$/);
  data.settings.syringeStep = 0.5;
  assert.match(dueToday(data, d(11, 12, 7)).find(x => x.key === 'mots-c').text, /^41\.5 units \(1\.66 mg\)$/);
});
