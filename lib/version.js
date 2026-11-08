// This app's version, and a light check for newer releases on GitHub (admin sees "update available").
// Turn the check off with UPDATE_CHECK=0.
import fs from 'node:fs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const REPO = 'fals3illusion/peptidetracker';

// "1.2.10" > "1.2.9"
export function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export function createUpdateCheck({ enabled = true, fetcher = globalThis.fetch, log = console } = {}) {
  let latest = null; // { version, url }
  async function check() {
    try {
      const res = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `PeptideTracker/${VERSION}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const r = await res.json();
      if (r.tag_name) latest = { version: String(r.tag_name).replace(/^v/, ''), url: String(r.html_url || '') };
    } catch (e) { log.log?.(`[update check] ${e.message}`); }
  }
  if (enabled) {
    setTimeout(check, 30000).unref();
    setInterval(check, 12 * 3600 * 1000).unref();
  }
  return {
    check,
    info: () => ({ current: VERSION, ...(latest && newer(latest.version, VERSION) && { latest: latest.version, url: latest.url }) }),
  };
}
