// Reset a user's password from the server (e.g. if the admin is locked out):
//   node set-password.js <username>
// In a PeptideTracker container:
//   cd /opt/peptidetracker && runuser -u peptidetracker -- env DATA_DIR=/var/lib/peptidetracker node set-password.js <username>
// It asks for the new password and logs that user out everywhere.
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createAuth } from './lib/auth.js';
import { migrateDataDir } from './lib/migrate.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const name = process.argv[2];
if (!name) { console.error('Usage: node set-password.js <username>'); process.exit(1); }
migrateDataDir(DATA_DIR, { log() {} });
const auth = createAuth(DATA_DIR);
const u = auth.byName(name);
if (!u) { console.error(`No user named "${name}". Users: ${auth.list().map(x => x.user).join(', ')}`); process.exit(1); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('New password: ');
rl.close();
try {
  auth.setPassword(u.id, password, { mustChange: false });
  console.log(`Password changed for ${u.user}. They've been logged out everywhere.`);
} catch (e) { console.error(e.message); process.exit(1); }
