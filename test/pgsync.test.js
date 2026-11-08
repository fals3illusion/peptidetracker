// Needs a throwaway database: PG_TEST_URL=postgres://... npm test
// Skipped when PG_TEST_URL is not set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPgSync } from '../lib/pgsync.js';

const url = process.env.PG_TEST_URL;
const opts = { skip: !url && 'PG_TEST_URL not set' };
let raw;
const quiet = { error() {}, log() {} };

const user = (id, name, role) => ({ id, user: name, role, salt: 'aa', hash: 'bb', mustChange: role !== 'admin', created: Date.UTC(2026, 9, 1), email: role === 'admin' ? null : `${name}@example.com`, firstName: name === 'sarah' ? 'Sarah' : '', lastName: '' });
const snap = () => ({
  users: [user('u1', 'alex', 'admin'), user('u2', 'sarah', 'user')],
  profiles: {
    u1: {
      entries: [{ id: 'e1', t: Date.UTC(2026, 6, 23, 12), weight: 250, note: 'Start' }, { id: 'e2', t: Date.UTC(2026, 9, 20, 12), weight: 211.8, note: '' }],
      supplies: [{ id: 's1', name: 'Tirzepatide', kind: 'vial', mg: 60, waterMl: 3, count: null, price: 200, opened: Date.UTC(2026, 8, 17), done: false, note: '' }],
      shots: [{ id: 'x1', t: Date.UTC(2026, 8, 17, 17), supplyId: 's1', name: 'Tirzepatide', doseMg: 5, units: 25, note: '', site: 'Stomach – left', groupId: 'g1' }],
      inventory: [{ id: 'i1', kind: 'water', name: 'Bac water', code: '#001', qty: 2, bottleMl: 30, openMl: 12 }],
      settings: { goal: 190, unit: 'lb', sites: ['Stomach – left', 'Stomach – right'] },
    },
    u2: { entries: [{ id: 'e3', t: Date.UTC(2026, 9, 21, 12), weight: 160, note: '' }], supplies: [], shots: [], inventory: [], settings: { goal: 140 } },
  },
  mail: { host: 'smtp.gmail.com', port: 587, secure: false, user: 'me@gmail.com', pass: 'app-pass', fromName: 'PeptideTracker', fromAddress: 'me@gmail.com', appUrl: 'https://pt.example.com' },
});

before(async () => {
  if (!url) return;
  raw = new pg.Client({ connectionString: url });
  await raw.connect();
  await raw.query('DROP VIEW IF EXISTS wt_settings, wt_people, pt_settings, pt_people');
  await raw.query('DROP TABLE IF EXISTS wt_entries, wt_supplies, wt_shots, wt_kv, wt_users, wt_user_settings, wt_inventory, pt_entries, pt_supplies, pt_shots, pt_kv, pt_users, pt_user_settings, pt_inventory');
});
after(async () => { await raw?.end(); });

test('empty database restores as null', opts, async () => {
  const s = createPgSync({ url, log: quiet });
  assert.equal(await s.restore(), null);
  await s.close();
});

test('mirror then restore round-trips every user', opts, async () => {
  const s = createPgSync({ url, log: quiet });
  let data = snap();
  s.setSource(() => data);
  await s.flush();
  assert.equal(s.status().lastError, null);
  assert.deepEqual(await s.restore(), data);

  // Rows carry their owner
  const { rows } = await raw.query('SELECT user_id, count(*)::int AS c FROM pt_entries GROUP BY 1 ORDER BY 1');
  assert.deepEqual(rows, [{ user_id: 'u1', c: 2 }, { user_id: 'u2', c: 1 }]);
  // Grafana views: names without hashes, settings per person
  const people = (await raw.query('SELECT * FROM pt_people ORDER BY username')).rows;
  assert.deepEqual(people, [{ user_id: 'u1', username: 'alex', first_name: '', last_name: '' }, { user_id: 'u2', username: 'sarah', first_name: 'Sarah', last_name: '' }]);
  const goal = (await raw.query(`SELECT settings->>'goal' AS g FROM pt_settings WHERE user_id = 'u2'`)).rows[0].g;
  assert.equal(goal, '140');

  // Removing a user removes their rows
  data = { users: [data.users[0]], profiles: { u1: data.profiles.u1 }, mail: null };
  await s.flush();
  const back = await s.restore();
  assert.deepEqual(back.users.map(u => u.user), ['alex']);
  assert.equal(back.mail, null, 'cleared email settings are removed from the backup');
  assert.equal((await raw.query(`SELECT count(*)::int AS c FROM pt_entries WHERE user_id = 'u2'`)).rows[0].c, 0);
  await s.close();
});

test('refuses to wipe weigh-ins with an empty local copy', opts, async () => {
  const s = createPgSync({ url, log: quiet, retryMs: 600000 });
  s.setSource(() => ({ users: snap().users, profiles: { u1: { ...snap().profiles.u1, entries: [] } } }));
  await s.flush();
  assert.match(s.status().lastError, /Refusing/);
  assert.equal((await raw.query('SELECT count(*)::int AS c FROM pt_entries')).rows[0].c, 2);
  await s.close();
});

test('restores an old single-user backup as the admin', opts, async () => {
  await raw.query('DROP VIEW IF EXISTS wt_settings, wt_people, pt_settings, pt_people');
  await raw.query('DROP TABLE IF EXISTS wt_entries, wt_supplies, wt_shots, wt_kv, wt_users, wt_user_settings, wt_inventory, pt_entries, pt_supplies, pt_shots, pt_kv, pt_users, pt_user_settings, pt_inventory');
  // The schema a very old version created (before the rename, so wt_ names), with one weigh-in and the login in wt_kv
  await raw.query(`
    CREATE TABLE wt_entries (id text PRIMARY KEY, taken_at timestamptz NOT NULL, weight_lb numeric(7,2) NOT NULL, note text NOT NULL DEFAULT '');
    CREATE TABLE wt_kv (key text PRIMARY KEY, value jsonb, updated_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO wt_entries VALUES ('old1', '2026-07-23T12:00:00Z', 250, 'Start');
    INSERT INTO wt_kv (key, value) VALUES ('account', '{"user":"alex","salt":"s","hash":"h"}'), ('settings', '{"goal":190}');
    CREATE VIEW wt_settings AS SELECT value AS settings FROM wt_kv WHERE key = 'settings';`);
  const s = createPgSync({ url, log: quiet });
  const back = await s.restore();
  assert.equal(back.users.length, 1);
  assert.deepEqual([back.users[0].user, back.users[0].role, back.users[0].hash], ['alex', 'admin', 'h']);
  const p = back.profiles[back.users[0].id];
  assert.deepEqual(p.entries.map(e => e.weight), [250]);
  assert.equal(p.settings.goal, 190);

  // Next backup tags the old rows and drops the legacy login row
  s.setSource(() => back);
  await s.flush();
  assert.equal(s.status().lastError, null);
  assert.equal((await raw.query(`SELECT user_id FROM pt_entries`)).rows[0].user_id, back.users[0].id);
  assert.equal((await raw.query(`SELECT count(*)::int AS c FROM pt_kv WHERE key = 'account'`)).rows[0].c, 0);
  await s.close();
});

test('unreachable database reports an error instead of crashing', opts, async () => {
  const s = createPgSync({ url: 'postgres://x:y@127.0.0.1:1/none', log: quiet, retryMs: 600000 });
  s.setSource(snap);
  await s.flush();
  assert.ok(s.status().lastError);
  await s.close();
});

test('a backup from before the rename (wt_ names) is renamed in place; Grafana keeps access', opts, async () => {
  await raw.query('DROP VIEW IF EXISTS wt_settings, wt_people, pt_settings, pt_people');
  await raw.query('DROP TABLE IF EXISTS wt_entries, wt_supplies, wt_shots, wt_kv, wt_users, wt_user_settings, wt_inventory, pt_entries, pt_supplies, pt_shots, pt_kv, pt_users, pt_user_settings, pt_inventory');
  // Build a current backup, then give it the old names (what an install from before the rename has).
  const first = createPgSync({ url, log: quiet });
  first.setSource(snap);
  await first.flush();
  await first.close();
  const { rows } = await raw.query(`SELECT relname, relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = current_schema() AND relname LIKE 'pt\\_%' AND relkind IN ('r','v','i')`);
  for (const r of rows) await raw.query(`ALTER ${{ r: 'TABLE', v: 'VIEW', i: 'INDEX' }[r.relkind]} ${r.relname} RENAME TO wt_${r.relname.slice(3)}`);
  const role = `grafana_test_${process.pid}`;
  await raw.query(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON wt_entries, wt_people, wt_settings TO ${role}`);

  const s = createPgSync({ url, log: quiet });
  assert.deepEqual((await s.check()).existing, { users: 2, entries: 3, shots: 1 }, 'old backup recognised');
  s.setSource(snap);
  await s.flush();
  const left = (await raw.query(`SELECT count(*)::int AS c FROM pg_class WHERE relname LIKE 'wt\\_%'`)).rows[0].c;
  assert.equal(left, 0, 'no wt_ tables left');
  assert.equal((await raw.query('SELECT count(*)::int AS c FROM pt_entries')).rows[0].c, 3);
  await raw.query(`SET ROLE ${role}`);
  try {
    assert.equal((await raw.query('SELECT count(*)::int AS c FROM pt_people')).rows[0].c, 2, 'Grafana user can still read');
    assert.ok((await raw.query('SELECT settings FROM pt_settings')).rows.length);
  } finally {
    await raw.query('RESET ROLE');
    await raw.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
  await s.close();
});
