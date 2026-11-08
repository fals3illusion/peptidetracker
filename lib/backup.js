// The PostgreSQL backup, set up either in the env file (PG_URL) or from the Admin page.
// Admin-page settings live in db.json in the data folder (readable by the app only).
import { jsonFile } from './store.js';
import { createPgSync } from './pgsync.js';

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export function dbConfig(input = {}, old = {}) {
  const host = clean(input.host);
  if (!/^[a-zA-Z0-9.-]+$|^\[?[0-9a-fA-F:]+\]?$/.test(host)) throw new Error('Enter the database server’s address (IP or hostname)');
  const port = input.port === '' || input.port == null ? 5432 : Number(input.port);
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Port must be a number like 5432');
  const database = clean(input.database, 63), user = clean(input.user, 63);
  if (!database) throw new Error('Enter the database name');
  if (!user) throw new Error('Enter the database username');
  // Blank password keeps the saved one.
  const password = input.password ? String(input.password) : (old.host ? old.password : '');
  return { host, port, database, user, password: password || '', ssl: input.ssl === true };
}
const pgOptions = c => ({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, ...(c.ssl && { ssl: { rejectUnauthorized: false } }) });

export function createBackup({ dataDir, envUrl = '', log = console, factory = createPgSync } = {}) {
  const file = jsonFile(dataDir, 'db.json', null);
  let sync = null, source = null, mode = null;

  function start() {
    const saved = file.read();
    if (envUrl) { sync = factory({ url: envUrl, log }); mode = 'env'; }
    else if (saved?.host) { sync = factory({ config: pgOptions(saved), log }); mode = 'app'; }
    else { sync = null; mode = null; }
    if (sync && source) sync.setSource(source);
  }
  start();

  const api = {
    get active() { return !!sync; },
    setSource(fn) { source = fn; sync?.setSource(fn); },
    schedule() { sync?.schedule(); },
    flush: () => sync?.flush(),
    restore: () => sync?.restore(),
    status: () => (sync ? { enabled: true, ...sync.status() } : { enabled: false }),
    // What the Admin page shows (never the password).
    settings() {
      const c = file.read();
      return {
        mode, envManaged: mode === 'env', ...api.status(),
        ...(mode === 'app' && c && { host: c.host, port: c.port, database: c.database, user: c.user, ssl: !!c.ssl, hasPassword: !!c.password }),
      };
    },
    // Try a connection without saving. Returns { existing: counts | null }.
    async test(input) {
      const cfg = dbConfig(input, file.read() || {});
      const probe = factory({ config: pgOptions(cfg), log });
      try { return { ...(await probe.check()), cfg }; } finally { await probe.close?.(); }
    },
    // Save from the Admin page, switch over and copy everything once. A database that already
    // holds a backup is only overwritten when the admin confirmed it (overwrite: true).
    async save(input, { overwrite = false } = {}) {
      if (mode === 'env') throw new Error('The backup is set in the server’s env file (PG_URL); change it there');
      const { cfg, existing } = await api.test(input);
      if (existing && !overwrite) { const e = new Error('That database already has a PeptideTracker backup'); e.existing = existing; throw e; }
      await sync?.close?.();
      file.write(cfg);
      start();
      await sync.flush();
      return api.settings();
    },
    // First-time setup: rebuild this install from a backup, then keep backing up to it.
    async restoreFrom(input) {
      const cfg = dbConfig(input, {});
      const probe = factory({ config: pgOptions(cfg), log });
      let backup;
      try { backup = await probe.restore(); } finally { await probe.close?.(); }
      if (!backup) throw new Error('No PeptideTracker backup found in that database');
      return { backup, activate() { file.write(cfg); start(); } };
    },
    async disable() {
      if (mode === 'env') throw new Error('The backup is set in the server’s env file (PG_URL); remove it there');
      await sync?.flush?.().catch(() => {});
      await sync?.close?.();
      file.remove();
      start();
    },
  };
  return api;
}
