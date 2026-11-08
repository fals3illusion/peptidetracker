import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protocolFor, mainShots, protocolDose, protocolStatus, describeProtocol } from '../public/protocols.js';

const d = (m, day, h = 8) => new Date(2026, m - 1, day, h).getTime();
const bpc = { name: 'BPC-157', freq: 'daily', unit: 'units', amount: 10, start: d(11, 1, 0), titrate: { enabled: false } };
const shots = [
  { t: d(10, 22, 12), name: 'Tirzepatide', doseMg: 10 },
  { t: d(11, 1), name: 'bpc-157', doseMg: 0.25, units: 10 },
  { t: d(11, 2), name: 'BPC-157', doseMg: 0.25, units: 10 },
];

test('protocolFor matches names in any case; mainShots excludes scheduled peptides', () => {
  assert.equal(protocolFor([bpc], 'bpc-157'), bpc);
  assert.equal(protocolFor([bpc], 'Tirzepatide'), null);
  assert.deepEqual(mainShots(shots, [bpc]).map(s => s.name), ['Tirzepatide']);
  assert.equal(mainShots(shots, []).length, 3);
});

test('static dose stays the same', () => {
  assert.deepEqual(protocolDose(bpc, shots), { amount: 10, taken: 2, stepUp: false });
});

test('increasing dose: +2 units after every 2 doses, capped at max', () => {
  const p = { ...bpc, titrate: { enabled: true, step: 2, every: 2, max: 13 } };
  assert.equal(protocolDose(p, []).amount, 10);
  const r = protocolDose(p, shots); // 2 taken -> step up to 12
  assert.equal(r.amount, 12);
  assert.equal(r.stepUp, true);
  assert.equal(r.untilIncrease, 2);
  const more = [...shots, { t: d(11, 3), name: 'BPC-157' }, { t: d(11, 4), name: 'BPC-157' }];
  const r2 = protocolDose(p, more); // 4 taken -> 14, capped at 13
  assert.equal(r2.amount, 13);
  assert.equal(r2.atMax, true);
  assert.equal(r2.stepUp, true);
  const r3 = protocolDose(p, [...more, { t: d(11, 5), name: 'BPC-157' }, { t: d(11, 6), name: 'BPC-157' }]);
  assert.equal(r3.stepUp, false, 'no more step-ups once at max');
});

test('shots before the start date do not count', () => {
  const p = { ...bpc, start: d(11, 2, 0), titrate: { enabled: true, step: 1, every: 1, max: 0 } };
  assert.equal(protocolDose(p, shots).taken, 1);
  assert.equal(protocolDose(p, shots).amount, 11);
});

test('daily: due today until a dose is logged today', () => {
  assert.equal(protocolStatus(bpc, shots, d(11, 3, 6)).state, 'due-today');
  assert.equal(protocolStatus(bpc, shots, d(11, 2, 20)).state, 'done-today');
});

test('certain days of the week', () => {
  const p = { ...bpc, freq: 'days', days: [1, 3, 5] }; // Mon Wed Fri
  assert.equal(protocolStatus(p, [], d(11, 2, 9)).state, 'due-today'); // Mon Nov 2
  const tue = protocolStatus(p, [], d(11, 3, 9));
  assert.equal(tue.state, 'not-today');
  assert.equal(new Date(tue.due).getDate(), 4);
});

test('every N days counts from the last dose', () => {
  const p = { ...bpc, freq: 'every', everyN: 3 };
  assert.equal(protocolStatus(p, shots, d(11, 4, 9)).state, 'not-today');
  assert.equal(protocolStatus(p, shots, d(11, 5, 9)).state, 'due-today');
  const late = protocolStatus(p, shots, d(11, 7, 9));
  assert.equal(late.state, 'overdue');
  assert.equal(late.daysLate, 2);
  // no doses yet: due on the start date
  assert.equal(protocolStatus(p, [], d(11, 1, 9)).state, 'due-today');
});

test('as needed is never due; starts in the future are not due', () => {
  assert.equal(protocolStatus({ ...bpc, freq: 'asneeded' }, [], d(11, 3)).state, 'as-needed');
  assert.equal(protocolStatus({ ...bpc, start: d(11, 10, 0) }, [], d(11, 3)).state, 'not-today');
});

test('describe', () => {
  const f = (v, u) => `${v} ${u}`;
  assert.equal(describeProtocol(bpc, f), 'Every day · 10 units');
  assert.equal(describeProtocol({ ...bpc, freq: 'days', days: [5, 1] }, f), 'Mon, Fri · 10 units');
  assert.equal(describeProtocol({ ...bpc, freq: 'every', everyN: 3, titrate: { enabled: true, step: 2, every: 7, max: 20 } }, f),
    'Every 3 days · 10 units, +2 units every 7 doses (max 20 units)');
});

test('split doses: same medication in the same minute (or same groupId) add up', async () => {
  const { combineShots } = await import('../public/protocols.js');
  const t = d(11, 5, 17);
  const shots = [
    { id: 'a', t, name: 'Tirzepatide', doseMg: 4, units: 20, supplyId: 'old' },
    { id: 'b', t, name: 'Tirzepatide', doseMg: 5, units: 20, supplyId: 'new' },
    { id: 'c', t, name: 'MOTS-C', doseMg: 1.67, units: 50 },                 // different track: separate
    { id: 'd', t: t + 3600000, name: 'Tirzepatide', doseMg: 2 },              // an hour later: separate
    { id: 'e', t: d(11, 6), name: 'BPC', doseMg: 0.25, groupId: 'g1' },
    { id: 'f', t: d(11, 6) + 120000, name: 'BPC', doseMg: 0.1, groupId: 'g1' }, // grouped explicitly
  ];
  const c = combineShots(shots, [{ name: 'MOTS-C' }, { name: 'BPC' }]);
  assert.equal(c.length, 4);
  const tirz = c.find(x => x.id === 'a');
  assert.deepEqual([tirz.doseMg, tirz.units, tirz.parts.length], [9, 40, 2]);
  assert.equal(c.find(x => x.id === 'c').parts, undefined);
  assert.equal(c.find(x => x.id === 'e').doseMg, 0.35);
  assert.equal(c.find(x => x.id === 'e').units, null, 'units only summed when every part has them');
});

test('dose plan counts a split dose as one shot', async () => {
  const { combineShots } = await import('../public/protocols.js');
  const { recommendDose } = await import('../public/titration.js');
  const plan = { enabled: true, start: 0, startDose: 2.5, step: 2.5, every: 4, maxDose: 15 };
  const w = (day, dose) => ({ t: d(10, day, 17), name: 'Tirzepatide', doseMg: dose });
  const shots = [w(1, 10), w(8, 10), w(15, 10), { ...w(22, 4) }, { ...w(22, 6) }];
  const r = recommendDose(combineShots(shots, []), plan, d(10, 29));
  assert.equal(r.doseMg, 12.5, '4 shots at 10 mg (one of them split 4+6) -> step up');
});
