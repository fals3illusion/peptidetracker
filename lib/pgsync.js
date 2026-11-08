// Mirrors all app data to PostgreSQL so nothing is lost if this box dies.
// The JSON files stay the app's working copy; Postgres is a live backup that
// can rebuild them (see restore()).
import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Backups made before the app was renamed used wt_* names. Rename them in place (keeping data,
// indexes and Grafana's grants) the first time this version connects.
const RENAME_OLD = `
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('pt_entries') IS NULL AND to_regclass('wt_entries') IS NOT NULL THEN
    FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relname LIKE 'wt\\_%' AND c.relkind IN ('r', 'v', 'i')
    LOOP
      EXECUTE format('ALTER %s %I RENAME TO %I',
        CASE r.relkind WHEN 'r' THEN 'TABLE' WHEN 'v' THEN 'VIEW' ELSE 'INDEX' END,
        r.relname, 'pt_' || substr(r.relname, 4));
    END LOOP;
  END IF;
END $$;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pt_entries (
  id        text PRIMARY KEY,
  taken_at  timestamptz NOT NULL,
  weight_lb numeric(7,2) NOT NULL,
  note      text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pt_supplies (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL,
  powder_mg  numeric,
  water_ml   numeric,
  dose_count integer,
  price      numeric(10,2),
  opened_at  timestamptz NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  note       text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pt_shots (
  id        text PRIMARY KEY,
  taken_at  timestamptz NOT NULL,
  supply_id text,
  name      text NOT NULL,
  dose_mg   numeric NOT NULL,
  units     numeric,
  note      text NOT NULL DEFAULT ''
);
ALTER TABLE pt_shots ADD COLUMN IF NOT EXISTS site text;
ALTER TABLE pt_shots ADD COLUMN IF NOT EXISTS group_id text;
ALTER TABLE pt_entries  ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE pt_supplies ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE pt_shots    ADD COLUMN IF NOT EXISTS user_id text;
CREATE INDEX IF NOT EXISTS pt_entries_user ON pt_entries (user_id, taken_at);
CREATE INDEX IF NOT EXISTS pt_shots_user ON pt_shots (user_id, taken_at);
CREATE TABLE IF NOT EXISTS pt_users (
  id          text PRIMARY KEY,
  username    text NOT NULL,
  role        text NOT NULL,
  salt        text NOT NULL,
  hash        text NOT NULL,
  must_change boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pt_users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE pt_users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE pt_users ADD COLUMN IF NOT EXISTS last_name text;
CREATE TABLE IF NOT EXISTS pt_inventory (
  id      text PRIMARY KEY,
  user_id text,
  item    jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS pt_user_settings (
  user_id  text PRIMARY KEY,
  settings jsonb NOT NULL
);
-- Legacy single-user storage; only read when restoring an old backup.
CREATE TABLE IF NOT EXISTS pt_kv (
  key        text PRIMARY KEY,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Read-only views for Grafana: names and settings, never password hashes.
CREATE OR REPLACE VIEW pt_people AS SELECT id AS user_id, username, first_name, last_name FROM pt_users;
`;
// Settings for Grafana. Column order (settings, user_id) is kept so existing grants and
// dashboards keep working.
const SETTINGS_VIEW = `CREATE OR REPLACE VIEW pt_settings AS SELECT settings, user_id FROM pt_user_settings`;

const iso = t => new Date(t).toISOString();
const n = v => (v == null ? null : Number(v));

// Table definitions: how each app record maps to a row and back.
const TABLES = [
  {
    name: 'pt_inventory', key: 'inventory',
    cols: 'id text, user_id text, item jsonb',
    toRow: (x, uid) => { const { id, ...item } = x; return { id, user_id: uid, item }; },
    fromRow: r => ({ id: r.id, ...r.item }),
  },
  {
    name: 'pt_entries', key: 'entries',
    cols: 'id text, user_id text, taken_at timestamptz, weight_lb numeric, note text',
    toRow: (e, uid) => ({ id: e.id, user_id: uid, taken_at: iso(e.t), weight_lb: e.weight, note: e.note || '' }),
    fromRow: r => ({ id: r.id, t: Date.parse(r.taken_at), weight: n(r.weight_lb), note: r.note }),
  },
  {
    name: 'pt_supplies', key: 'supplies',
    cols: 'id text, user_id text, name text, kind text, powder_mg numeric, water_ml numeric, dose_count integer, price numeric, opened_at timestamptz, done boolean, note text',
    toRow: (s, uid) => ({ id: s.id, user_id: uid, name: s.name, kind: s.kind, powder_mg: s.mg, water_ml: s.waterMl, dose_count: s.count, price: s.price, opened_at: iso(s.opened), done: !!s.done, note: s.note || '' }),
    fromRow: r => ({ id: r.id, name: r.name, kind: r.kind, mg: n(r.powder_mg), waterMl: n(r.water_ml), count: n(r.dose_count), price: n(r.price), opened: Date.parse(r.opened_at), done: r.done, note: r.note }),
  },
  {
    name: 'pt_shots', key: 'shots',
    cols: 'id text, user_id text, taken_at timestamptz, supply_id text, name text, dose_mg numeric, units numeric, note text, site text, group_id text',
    toRow: (s, uid) => ({ id: s.id, user_id: uid, taken_at: iso(s.t), supply_id: s.supplyId, name: s.name, dose_mg: s.doseMg, units: s.units, note: s.note || '', site: s.site ?? null, group_id: s.groupId ?? null }),
    fromRow: r => ({ id: r.id, t: Date.parse(r.taken_at), supplyId: r.supply_id, name: r.name, doseMg: n(r.dose_mg), units: n(r.units), note: r.note, site: r.site, ...(r.group_id ? { groupId: r.group_id } : {}) }),
  },
];

// Make a table match `rows` exactly: insert/update every row, delete the rest.
async function upsertAll(client, table, cols, rows, key = 'id') {
  const names = cols.split(', ').map(c => c.split(' ')[0]);
  const sets = names.filter(c => c !== key).map(c => `${c} = EXCLUDED.${c}`).join(', ');
  // Name the columns so table column order doesn't matter (older tables got user_id added last).
  await client.query(
    `INSERT INTO ${table} (${names.join(', ')}) SELECT ${names.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${cols})
     ON CONFLICT (${key}) DO UPDATE SET ${sets}`,
    [JSON.stringify(rows)],
  );
  await client.query(`DELETE FROM ${table} WHERE NOT (${key} = ANY($1::text[]))`, [rows.map(r => r[key])]);
}

// Timers that don't keep the process alive on their own; delay capped to Node's max.
const later = (fn, ms) => setTimeout(fn, Math.min(ms, 2 ** 31 - 1)).unref();

// `url` (postgres://…) or `config` ({ host, port, database, user, password, ssl }).
export function createPgSync({ url, config, debounceMs = 1500, retryMs = 60000, log = console }) {
  const pool = new pg.Pool({ ...(config || { connectionString: url }), max: 2, connectionTimeoutMillis: 5000 });
  pool.on('error', e => log.error('[pgsync] pool error:', e.message));
  let source = null, timer = null, running = null, dirty = false;
  const state = { enabled: true, lastOk: null, lastError: null };
  let schemaReady = false;

  async function ensureSchema(client) {
    if (schemaReady) return;
    await client.query(RENAME_OLD);
    await client.query(SCHEMA);
    await client.query(SETTINGS_VIEW);
    schemaReady = true;
  }

  async function mirror() {
    const snap = source();
    const client = await pool.connect();
    try {
      await ensureSchema(client);
      await client.query('BEGIN');
      const profiles = Object.entries(snap.profiles).filter(([uid]) => uid !== '__unclaimed');
      for (const t of TABLES) {
        const rows = profiles.flatMap(([uid, p]) => (p[t.key] || []).map(x => t.toRow(x, uid)));
        // Safety net: never wipe backed-up weigh-ins because of an empty local copy.
        if (!rows.length && t.key === 'entries') {
          const { rows: [{ c }] } = await client.query(`SELECT count(*)::int AS c FROM ${t.name}`);
          if (c > 0) throw new Error('Refusing to erase backed-up weigh-ins with an empty local copy');
        }
        await upsertAll(client, t.name, t.cols, rows);
      }
      await upsertAll(client, 'pt_users', 'id text, username text, role text, salt text, hash text, must_change boolean, created_at timestamptz, email text, first_name text, last_name text',
        snap.users.map(u => ({ id: u.id, username: u.user, role: u.role, salt: u.salt, hash: u.hash, must_change: !!u.mustChange, created_at: iso(u.created || Date.now()), email: u.email || null, first_name: u.firstName || '', last_name: u.lastName || '' })));
      // Email (SMTP) settings, so a restore keeps invites working.
      if (snap.mail) {
        await client.query(`INSERT INTO pt_kv (key, value, updated_at) VALUES ('mail', $1, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(snap.mail)]);
      } else {
        await client.query(`DELETE FROM pt_kv WHERE key = 'mail'`);
      }
      await upsertAll(client, 'pt_user_settings', 'user_id text, settings jsonb',
        profiles.map(([uid, p]) => ({ user_id: uid, settings: p.settings || {} })), 'user_id');
      // The old single-user rows (including a password hash) are no longer needed.
      if (snap.users.length) await client.query(`DELETE FROM pt_kv WHERE key IN ('account', 'settings')`);
      await client.query('COMMIT');
      state.lastOk = Date.now();
      state.lastError = null;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function run() {
    timer = null;
    if (running) { dirty = true; return running; }
    dirty = false;
    running = mirror()
      .catch(e => {
        state.lastError = e.message;
        log.error('[pgsync] backup failed, retrying in', retryMs / 1000, 's:', e.message);
        if (!timer) timer = later(run, retryMs);
      })
      .finally(() => {
        running = null;
        if (dirty) schedule();
      });
    return running;
  }

  function schedule() {
    if (!source) return;
    clearTimeout(timer);
    timer = later(run, debounceMs);
  }

  return {
    setSource(fn) { source = fn; },
    schedule,
    status: () => ({ ...state }),
    // Write now and wait (used at startup, shutdown, and in tests).
    async flush() {
      clearTimeout(timer);
      await run();
      if (running) await running;
    },
    // Connect and report what's already there (used before turning the backup on).
    async check() {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        const { rows: [t] } = await client.query(`SELECT to_regclass('pt_users') IS NOT NULL AS pt, to_regclass('wt_users') IS NOT NULL AS wt`);
        if (!t.pt && !t.wt) return { existing: null };
        const pre = t.pt ? 'pt' : 'wt'; // wt_ = a backup from before the rename (renamed on first use)
        const one = async q => (await client.query(q)).rows[0].c;
        const existing = {
          users: await one(`SELECT count(*)::int AS c FROM ${pre}_users`),
          entries: await one(`SELECT count(*)::int AS c FROM ${pre}_entries`),
          shots: await one(`SELECT count(*)::int AS c FROM ${pre}_shots`),
        };
        return { existing: existing.users || existing.entries || existing.shots ? existing : null };
      } finally { client.release(); }
    },
    async close() { clearTimeout(timer); await pool.end().catch(() => {}); },
    // Read everything back as { users, profiles }. Returns null if the backup is empty.
    async restore() {
      const client = await pool.connect();
      try {
        await ensureSchema(client);
        const { rows: urows } = await client.query('SELECT * FROM pt_users ORDER BY created_at');
        const users = urows.map(r => ({ id: r.id, user: r.username, role: r.role, salt: r.salt, hash: r.hash, mustChange: r.must_change, created: Date.parse(r.created_at), email: r.email ?? null, firstName: r.first_name ?? '', lastName: r.last_name ?? '' }));
        const { rows: kv } = await client.query('SELECT key, value FROM pt_kv');
        const legacy = k => kv.find(r => r.key === k)?.value ?? null;
        // A backup made before multiple users: its only login becomes the admin.
        if (!users.length && legacy('account')) {
          const a = legacy('account');
          users.push({ id: randomUUID(), user: a.user, role: 'admin', salt: a.salt, hash: a.hash, mustChange: false, created: Date.now() });
        }
        const owner = users.find(u => u.role === 'admin')?.id;
        const profiles = {};
        const prof = uid => (profiles[uid] ||= { entries: [], supplies: [], shots: [], inventory: [], settings: {} });
        for (const t of TABLES) {
          const { rows } = await client.query(`SELECT * FROM ${t.name}`);
          for (const r of rows) {
            const uid = r.user_id || owner;
            if (uid) prof(uid)[t.key].push(t.fromRow(r));
          }
        }
        const { rows: srows } = await client.query('SELECT user_id, settings FROM pt_user_settings');
        for (const r of srows) prof(r.user_id).settings = r.settings;
        if (owner && legacy('settings') && !srows.length) prof(owner).settings = legacy('settings');
        for (const u of users) prof(u.id);
        return users.length ? { users, profiles, mail: legacy('mail') } : null;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
