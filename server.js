// Entry point: node server.js
// env: PORT, DATA_DIR, PG_URL (optional PostgreSQL backup, e.g. postgres://user:pass@host:5432/db;
//      it can also be set up from Admin → Backup & Grafana)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';
import { createAuth } from './lib/auth.js';
import { jsonFile } from './lib/store.js';
import { createBackup } from './lib/backup.js';
import { createMail } from './lib/mail.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3080);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PG_URL = process.env.PG_URL || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// PostgreSQL backup: PG_URL in the env file, or set up later in Admin → Backup & Grafana.
const backup = createBackup({ dataDir: DATA_DIR, envUrl: PG_URL });
if (backup.active) {
  const dataFile = jsonFile(DATA_DIR, 'data.json', null);
  if (!dataFile.exists()) {
    // Fresh install: rebuild from the backup. Don't start empty while the
    // database is unreachable, or we could later overwrite the good copy.
    for (let attempt = 1; ; attempt++) {
      try {
        const saved = await backup.restore();
        if (saved) {
          createAuth(DATA_DIR).replaceAll(saved.users);
          createMail(DATA_DIR).restore(saved.mail);
          dataFile.write({ version: 2, profiles: saved.profiles });
          const count = k => Object.values(saved.profiles).reduce((n, p) => n + p[k].length, 0);
          console.log(`[pgsync] Restored ${saved.users.length} users, ${count('entries')} weigh-ins, ${count('shots')} shots from PostgreSQL`);
        } else {
          console.log('[pgsync] Backup is empty; starting fresh');
        }
        break;
      } catch (e) {
        console.error(`[pgsync] Can't reach PostgreSQL to restore (attempt ${attempt}): ${e.message}. Retrying in 10s…`);
        await sleep(10000);
      }
    }
  }
}

const handler = createApp({ dataDir: DATA_DIR, publicDir: path.join(ROOT, 'public'), backup });
const server = http.createServer(handler).listen(PORT, () => {
  console.log(`PeptideTracker on http://0.0.0.0:${PORT}${backup.active ? ' (PostgreSQL backup on)' : ''}`);
});
backup.schedule(); // initial backup

// Finish any pending backup before the container stops.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await Promise.race([backup.flush(), sleep(8000)]);
    process.exit(0);
  });
}
