// Users and logins: scrypt password hashes + random session tokens.
//
// users.json:    [{ id, user, salt, hash, role: 'admin'|'user', mustChange, created, email, firstName, lastName }]
// sessions.json: { sha256(token): { exp, userId } }
// invites.json:  [{ id, tokenHash, email, by, created, exp }]   (email invite links)
// resets.json:   { sha256(token): { userId, exp } }             (forgot-password links)
// Link tokens are random; only their hashes are stored, so a leaked file can't be used to sign in.
import crypto from 'node:crypto';
import { jsonFile } from './store.js';

const SESSION_DAYS = 90;
const INVITE_DAYS = 7;
const RESET_MINUTES = 60;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function validUsername(user) {
  if (typeof user !== 'string' || !/^[\w.@-]{1,64}$/.test(user)) return 'Username can use letters, numbers, and . _ - @ (max 64).';
  return null;
}
export function validPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return 'Password must be at least 8 characters.';
  return null;
}
export function validCredentials(user, password) {
  return validUsername(user) || validPassword(password);
}

// What's safe to send to the browser or a Grafana-readable table.
export const publicUser = u => ({
  id: u.id, user: u.user, role: u.role, mustChange: !!u.mustChange, created: u.created,
  email: u.email || null, firstName: u.firstName || '', lastName: u.lastName || '',
});
const newToken = () => crypto.randomBytes(32).toString('base64url');
const sameEmail = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function createAuth(dataDir) {
  const usersFile = jsonFile(dataDir, 'users.json', []);
  const sessions = jsonFile(dataDir, 'sessions.json', {});
  const invitesFile = jsonFile(dataDir, 'invites.json', []);
  const resetsFile = jsonFile(dataDir, 'resets.json', {});
  const fails = new Map(); // ip -> [timestamps]

  const all = () => usersFile.read();
  const byId = id => all().find(u => u.id === id) || null;
  const byName = name => (typeof name === 'string' ? all().find(u => u.user.toLowerCase() === name.toLowerCase()) : null) || null;
  const byEmail = email => (typeof email === 'string' ? all().find(u => sameEmail(u.email, email)) : null) || null;
  // Sign in with either a username or an email address.
  const byLogin = login => byName(login) || (typeof login === 'string' && login.includes('@') ? byEmail(login) : null);
  const liveInvites = () => invitesFile.read().filter(i => i.exp > Date.now());

  function saveUser(u) {
    const list = all();
    const i = list.findIndex(x => x.id === u.id);
    if (i === -1) list.push(u); else list[i] = u;
    usersFile.write(list);
  }

  function endSessionsFor(userId, keepHash = null) {
    const s = sessions.read();
    for (const [k, v] of Object.entries(s)) if (v.userId === userId && k !== keepHash) delete s[k];
    sessions.write(s);
  }

  return {
    hasUsers: () => all().length > 0,
    list: () => all(),
    get: byId,
    byName,
    byEmail,
    byLogin,
    replaceAll(list) { usersFile.write(list); },

    // Returns the new user (without secrets) or throws an Error with a message.
    create({ user, password, role = 'user', mustChange = true, email = null, firstName = '', lastName = '' }) {
      const problem = validCredentials(user, password);
      if (problem) throw new Error(problem);
      if (byName(user)) throw new Error('That username is already taken.');
      if (email && byEmail(email)) throw new Error('Someone already uses that email address.');
      const u = { id: crypto.randomUUID(), user, ...hashPassword(password), role, mustChange, created: Date.now(), email, firstName, lastName };
      saveUser(u);
      return u;
    },
    setPassword(userId, password, { mustChange = false, keepToken = null } = {}) {
      const problem = validPassword(password);
      if (problem) throw new Error(problem);
      const u = byId(userId);
      if (!u) throw new Error('No such user.');
      saveUser({ ...u, ...hashPassword(password), mustChange });
      endSessionsFor(userId, keepToken ? hashToken(keepToken) : null);
    },
    setEmail(userId, email) {
      const u = byId(userId);
      if (!u) return;
      const other = email && byEmail(email);
      if (other && other.id !== userId) throw new Error('Someone already uses that email address.');
      saveUser({ ...u, email: email || null });
    },
    // Name and/or email. Throws if the email belongs to someone else.
    updateProfile(userId, { firstName, lastName, email }) {
      const u = byId(userId);
      if (!u) throw new Error('No such user.');
      const next = { ...u };
      if (firstName !== undefined) next.firstName = firstName;
      if (lastName !== undefined) next.lastName = lastName;
      if (email !== undefined) {
        const other = email && byEmail(email);
        if (other && other.id !== userId) throw new Error('Someone already uses that email address.');
        next.email = email || null;
      }
      saveUser(next);
      return next;
    },

    // ---- email invites ----
    invites: () => liveInvites().map(({ tokenHash, ...i }) => i),
    // Returns { invite, token }. Re-inviting the same email replaces the old link.
    createInvite(email, by) {
      if (byEmail(email)) throw new Error('Someone already has an account with that email.');
      const token = newToken();
      const invite = { id: crypto.randomUUID(), tokenHash: hashToken(token), email, by, created: Date.now(), exp: Date.now() + INVITE_DAYS * 86400000 };
      invitesFile.write([...liveInvites().filter(i => !sameEmail(i.email, email)), invite]);
      return { invite, token };
    },
    // New link for an existing invite (the old link stops working).
    renewInvite(id) {
      const list = liveInvites();
      const i = list.find(x => x.id === id);
      if (!i) throw new Error('That invite has expired or was cancelled.');
      const token = newToken();
      Object.assign(i, { tokenHash: hashToken(token), created: Date.now(), exp: Date.now() + INVITE_DAYS * 86400000 });
      invitesFile.write(list);
      return { invite: i, token };
    },
    cancelInvite(id) { invitesFile.write(liveInvites().filter(i => i.id !== id)); },
    inviteByToken(token) {
      if (typeof token !== 'string' || !token) return null;
      return liveInvites().find(i => i.tokenHash === hashToken(token)) || null;
    },

    // ---- forgot password ----
    createReset(userId) {
      const token = newToken();
      const now = Date.now();
      const r = resetsFile.read();
      // One live link per person; drop expired ones while we're here.
      for (const [k, v] of Object.entries(r)) if (v.userId === userId || v.exp < now) delete r[k];
      r[hashToken(token)] = { userId, exp: now + RESET_MINUTES * 60000 };
      resetsFile.write(r);
      return token;
    },
    resetUser(token) {
      if (typeof token !== 'string' || !token) return null;
      const v = resetsFile.read()[hashToken(token)];
      return v && v.exp > Date.now() ? byId(v.userId) : null;
    },
    consumeReset(token) {
      const r = resetsFile.read();
      delete r[hashToken(token)];
      resetsFile.write(r);
    },
    remove(userId) {
      usersFile.write(all().filter(u => u.id !== userId));
      endSessionsFor(userId);
    },

    // Returns the user if the password matches, else null. Always does the hashing work
    // so response time doesn't reveal whether a username exists.
    verify(name, password) {
      const u = byLogin(name);
      if (typeof password !== 'string') return null;
      const { hash } = hashPassword(password, u ? u.salt : DUMMY_SALT);
      if (!u) return null;
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex')) ? u : null;
    },

    rateLimited(ip) {
      const now = Date.now();
      const recent = (fails.get(ip) || []).filter(t => now - t < FAIL_WINDOW_MS);
      fails.set(ip, recent);
      return recent.length >= MAX_FAILS;
    },
    recordFail(ip) { fails.set(ip, [...(fails.get(ip) || []), Date.now()]); },
    clearFails(ip) { fails.delete(ip); },

    createSession(userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const s = sessions.read();
      const now = Date.now();
      for (const [k, v] of Object.entries(s)) if (!v || v.exp < now) delete s[k];
      s[hashToken(token)] = { exp: now + SESSION_DAYS * 86400000, userId };
      sessions.write(s);
      return { token, maxAge: SESSION_DAYS * 86400 };
    },
    // The logged-in user for a token, or null.
    sessionUser(token) {
      if (!token) return null;
      const v = sessions.read()[hashToken(token)];
      if (!v || typeof v !== 'object' || v.exp <= Date.now()) return null;
      return byId(v.userId);
    },
    endSession(token) {
      if (!token) return;
      const s = sessions.read();
      delete s[hashToken(token)];
      sessions.write(s);
    },
  };
}
