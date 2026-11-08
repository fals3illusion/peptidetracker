import fs from 'node:fs';
import path from 'node:path';

// A JSON file that is read once and written atomically (temp file + rename),
// so a crash mid-write never leaves a broken file.
export function jsonFile(dir, name, defaults) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  return {
    file,
    exists: () => fs.existsSync(file),
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return structuredClone(defaults);
        throw e;
      }
    },
    write(data) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    remove() { fs.rmSync(file, { force: true }); },
  };
}
