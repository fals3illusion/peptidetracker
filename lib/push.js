// Phone/browser notifications (Web Push). Keys are generated once and kept in the data folder.
// iPhone: works for the app added to the Home Screen (iOS 16.4+), over HTTPS.
import * as webpush from 'web-push';
import { jsonFile } from './store.js';

export function createPush(dataDir, { sender, contact } = {}) {
  const keysFile = jsonFile(dataDir, 'vapid.json', null);
  const subsFile = jsonFile(dataDir, 'push.json', {}); // { userId: [subscription, ...] }
  let keys = keysFile.read();
  if (!keys?.publicKey) { keys = webpush.generateVAPIDKeys(); keysFile.write(keys); }
  const send = sender || ((sub, payload) => webpush.sendNotification(sub, payload, {
    vapidDetails: { subject: contact?.() || 'mailto:admin@localhost', publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 6 * 3600,
  }));

  const validSub = s => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';

  return {
    publicKey: () => keys.publicKey,
    subscribe(userId, sub, ua = '') {
      if (!validSub(sub)) throw new Error('Invalid subscription');
      const all = subsFile.read();
      const mine = (all[userId] || []).filter(x => x.endpoint !== sub.endpoint);
      mine.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: String(ua).slice(0, 120), created: Date.now() });
      all[userId] = mine.slice(-10); // a few devices per person
      subsFile.write(all);
    },
    unsubscribe(userId, endpoint) {
      const all = subsFile.read();
      all[userId] = (all[userId] || []).filter(x => x.endpoint !== endpoint);
      subsFile.write(all);
    },
    count: userId => (subsFile.read()[userId] || []).length,
    removeUser(userId) { const all = subsFile.read(); delete all[userId]; subsFile.write(all); },
    // Send to all of a person's devices; forget devices that have unsubscribed. Returns how many got it.
    async notify(userId, { title, body, url = '/', tag = 'wt' }) {
      const subs = subsFile.read()[userId] || [];
      let ok = 0;
      const gone = [];
      for (const s of subs) {
        try { await send(s, JSON.stringify({ title, body, url, tag })); ok++; }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); }
      }
      if (gone.length) {
        const all = subsFile.read();
        all[userId] = (all[userId] || []).filter(x => !gone.includes(x.endpoint));
        subsFile.write(all);
      }
      return ok;
    },
  };
}
