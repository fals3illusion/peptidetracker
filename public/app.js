import { project, requiredPace } from './projection.js';
import { takenFrom, concentration, mgToUnits, unitsToMg, usage, shotCost, totalSpent, shotAt, doseChanges, nextShotDue, SITES, suggestSite, shotStatus, refillAlerts } from './supplies.js';
import { movingAverage, progress } from './progress.js';
import { recommendDose, dosePlan } from './titration.js';
import { protocolFor, mainShots, shotsOf, protocolDose, protocolStatus, describeProtocol, WEEKDAYS_SHORT, combineShots } from './protocols.js';
import { useBy, reorderPlan, doseResults, dosesPerWeek } from './planning.js';

const DAY = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LB_PER_KG = 2.20462262;
const $ = id => document.getElementById(id);

let state = { entries: [], supplies: [], shots: [], settings: { goal: null, goalDate: null, unit: 'lb' } };
let user = null;
let showAll = false;
let editingEntryId = null;
let editingSupplyId = null;
let editingShotId = null;
let showAllShots = false;

// ---------- formatting (weights are stored in lb) ----------
const unit = () => state.settings.unit;
const toDisp = lb => unit() === 'kg' ? lb / LB_PER_KG : lb;
const fromDisp = v => unit() === 'kg' ? v * LB_PER_KG : v;
const fmtW = lb => `${toDisp(lb).toFixed(1)} ${unit()}`;
const fmtNum = lb => toDisp(lb).toFixed(1);
const thisYear = new Date().getFullYear();
const yearIfOld = t => new Date(t).getFullYear() !== thisYear ? { year: 'numeric' } : {};
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtShort = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...yearIfOld(t) });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const money = v => v.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = v => v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
// mg values for inputs keep more precision (peptide doses can be a few mcg)
const trimMg = v => +(+v).toFixed(4);
const trim = v => +(+v).toFixed(2); // 7.50 -> 7.5
const signed = lb => {
  const v = toDisp(lb);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// "6 doses taken (1 × 5 mg, 4 × 7.5 mg, 1 × 10 mg)"
function takenText(supply) {
  const t = takenFrom(supply, state.shots);
  if (!t.count) return 'No doses taken yet';
  const parts = t.byDose.map(g => `${g.count} × ${trim(g.doseMg)} mg`).join(', ');
  return `<b>${t.count}</b> dose${t.count === 1 ? '' : 's'} taken${t.byDose.length ? ` (${parts})` : ''}`;
}
// 0.25 mg -> "250 mcg"; 7.5 -> "7.5 mg"
const fmtMg = mg => (mg != null && mg > 0 && mg < 1 ? `${trim(mg * 1000)} mcg` : `${trim(mg)} mg`);
const fmtAmount = (v, unitName) => (unitName === 'units' ? `${trim(v)} unit${v === 1 ? '' : 's'}` : fmtMg(v));
const shotLabel = m => `${m.name} ${fmtMg(m.doseMg)}`;
const protocols = () => state.settings.protocols || [];
// Medications: extras (sites, vial defaults) and custom injection sites.
const lc = n => String(n || '').trim().toLowerCase();
const extrasFor = name => (state.settings.medExtras || {})[lc(name)] || {};
const allSites = () => [...SITES, ...(state.settings.customSites || [])];
function rotationFor(name) {
  const all = allSites();
  const own = extrasFor(name).sites;
  const rot = own?.length ? own : (state.settings.sites?.length ? state.settings.sites : SITES);
  const ok = all.filter(x => rot.includes(x));
  return ok.length ? ok : SITES;
}
// A medication the app knows how to treat (has a schedule, settings, or history).
const isKnownMed = name => !!name && (!!protocolFor(protocols(), name) || !!extrasFor(name).kind
  || state.shots.some(x => lc(x.name) === lc(name)) || state.supplies.some(x => lc(x.name) === lc(name)));
// The main GLP-1 track: shots of medications without their own schedule.
// Doses: parts of one dose taken from two vials are counted once (see combineShots).
const doses = () => combineShots(state.shots, protocols());
const mainList = () => combineShots(mainShots(state.shots, protocols()), protocols());
// Latest open vial for a medication (by name).
const openVialFor = name => [...state.supplies].reverse().find(v => !v.done && v.name.trim().toLowerCase() === String(name).trim().toLowerCase()) || null;
// The vial to draw from next: the oldest open one that still has something left (use up old vials first).
function vialToUse(name) {
  const open = state.supplies.filter(v => !v.done && v.name.trim().toLowerCase() === String(name).trim().toLowerCase()).sort((a, b) => a.opened - b.opened);
  return open.find(v => v.kind !== 'vial' || (usage(v, state.shots).leftMg ?? 1) > 1e-6) || open.at(-1) || null;
}
const planOn = () => state.settings.showShots !== false && !!state.settings.plan?.enabled;
// When the next shot is due (uses the shot-day setting if set).
function nextShotAt() {
  const st = shotStatus(mainList(), state.settings.shotDay, Date.now());
  return st.due ?? nextShotDue(mainList()) ?? Date.now();
}
// Strength of the vial you're using now (latest open vial with mg + water).
function currentConc() {
  const v = [...state.supplies].reverse().find(s => !s.done && concentration(s) && !protocolFor(protocols(), s.name));
  return v ? concentration(v) : null;
}
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function localInputValue(t = Date.now()) {
  const d = new Date(t);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
const localDateValue = t => localInputValue(t).slice(0, 10);
// Dates without a time are stored as local noon so they never slip a day.
const dateInputToMs = v => new Date(`${v}T12:00`).getTime();

function timeAway(t) {
  const w = (t - Date.now()) / (7 * DAY);
  if (w < 1.5) return `${Math.max(1, Math.round(w * 7))} days`;
  if (w < 9) return `${Math.round(w)} weeks`;
  return `${(w / 4.345).toFixed(1).replace(/\.0$/, '')} months`;
}

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) {
    showAuth(false);
    throw new Error('Please sign in again.');
  }
  if (res.status === 403 && data.mustChange) {
    showNewPassword();
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function refresh() {
  state = await api('GET', '/api/data');
  render();
}

// ---------- login ----------
let setupMode = false;
let role = null;
let firstName = '';
const AUTH_CARDS = ['authForm', 'forgotForm', 'inviteForm', 'resetForm', 'linkErr', 'newPwForm', 'restoreForm'];
function showCard(id) {
  $('appView').hidden = true;
  $('adminView').hidden = true;
  $('invView').hidden = true;
  $('medsView').hidden = true;
  $('authView').hidden = false;
  for (const c of AUTH_CARDS) $(c).hidden = c !== id;
}
function showAuth(setup) {
  setupMode = setup;
  showCard('authForm');
  $('authTitle').textContent = setup ? 'Create your login' : 'Sign in';
  $('authHint').textContent = setup ? 'Pick a username and password. You’ll use these to open the tracker from anywhere.' : '';
  $('authUserLabel').textContent = setup ? 'Username' : 'Username or email';
  $('authBtn').textContent = setup ? 'Create login' : 'Sign in';
  $('confirmWrap').hidden = !setup;
  $('forgotLink').hidden = setup;
  $('restoreLink').hidden = !setup;
  $('authPass').autocomplete = setup ? 'new-password' : 'current-password';
  $('authPass2').required = setup;
  $('authMsg').textContent = '';
  $('authUser').focus();
}
async function whoAmI() {
  const who = await (await fetch('/api/auth')).json();
  user = who.user; role = who.role; firstName = who.firstName || '';
  return who;
}
async function showApp() {
  $('authView').hidden = true;
  $('appView').hidden = false;
  $('whoami').textContent = user ? `Signed in as ${firstName ? `${firstName} (${user})` : user}` : '';
  $('pwUser').value = user || '';
  $('adminBtn').hidden = role !== 'admin';
  await refresh();
  route();
  if (pushSupported() && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
// After signing in with a temporary password set by the admin.
function showNewPassword() {
  showCard('newPwForm');
  $('newPwName').textContent = firstName || user || '';
  $('newPwUser').value = user || '';
  $('newPwMsg').textContent = '';
  $('newPw1').focus();
}
$('newPwForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if ($('newPw1').value !== $('newPw2').value) { $('newPwMsg').textContent = 'Passwords don’t match.'; return; }
  try {
    await api('POST', '/api/password', { password: $('newPw1').value });
    $('newPw1').value = $('newPw2').value = '';
    await showApp();
  } catch (e) { $('newPwMsg').textContent = e.message; }
});
$('newPwLogout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  showAuth(false);
});
$('authForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const u = $('authUser').value.trim(), p = $('authPass').value;
  if (setupMode && p !== $('authPass2').value) { $('authMsg').textContent = 'Passwords don’t match.'; return; }
  try {
    const r = await api('POST', setupMode ? '/api/setup' : '/api/login', { user: u, password: p });
    $('authPass').value = $('authPass2').value = '';
    await whoAmI();
    if (r.mustChange) showNewPassword();
    else await showApp();
  } catch (e) { $('authMsg').textContent = e.message; }
});
document.querySelectorAll('#authView [data-back]').forEach(b => b.addEventListener('click', () => showAuth(false)));

// Forgot password
$('forgotLink').addEventListener('click', () => {
  showCard('forgotForm');
  $('forgotLogin').value = $('authUser').value;
  $('forgotMsg').textContent = '';
  $('forgotLogin').focus();
});
$('forgotForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('POST', '/api/forgot', { login: $('forgotLogin').value.trim() });
    $('forgotMsg').className = 'msg ok';
    $('forgotMsg').textContent = 'If that account has an email address, a reset link is on its way. Check your inbox (and spam). The link works for 1 hour.';
  } catch (e) { $('forgotMsg').className = 'msg'; $('forgotMsg').textContent = e.message; }
});

// Links from emails: ?invite=… and ?reset=…
let linkToken = null;
function linkError(msg) { showCard('linkErr'); $('linkErrMsg').textContent = msg; }
async function openInvite(token) {
  linkToken = token;
  const res = await fetch(`/api/invite/${encodeURIComponent(token)}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return linkError(d.error || 'This invite link isn’t valid.');
  showCard('inviteForm');
  $('inviteIntro').innerHTML = d.email
    ? `You were invited as <b>${esc(d.email)}</b>. Pick a username and password — you can sign in with either your username or this email.`
    : 'You’ve been invited to PeptideTracker. Pick a username and password to create your account.';
  $('invEmailWrap').hidden = !!d.email;
  if (d.name && !$('invFirst').value) $('invFirst').value = d.name.split(' ')[0];
  $('inviteMsg').textContent = '';
  $('invFirst').focus();
}
$('inviteForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if ($('invPass').value !== $('invPass2').value) { $('inviteMsg').textContent = 'Passwords don’t match.'; return; }
  try {
    await api('POST', `/api/invite/${encodeURIComponent(linkToken)}`, {
      firstName: $('invFirst').value.trim(), lastName: $('invLast').value.trim(),
      user: $('invUser').value.trim(), password: $('invPass').value, email: $('invEmail').value.trim(),
    });
    await whoAmI();
    await showApp();
  } catch (e) { $('inviteMsg').textContent = e.message; }
});
async function openReset(token) {
  linkToken = token;
  const res = await fetch(`/api/reset/${encodeURIComponent(token)}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return linkError(d.error || 'This reset link isn’t valid.');
  showCard('resetForm');
  $('resetUser').textContent = d.user;
  $('resetUserField').value = d.user;
  $('resetMsg').textContent = '';
  $('resetPass').focus();
}
$('resetForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if ($('resetPass').value !== $('resetPass2').value) { $('resetMsg').textContent = 'Passwords don’t match.'; return; }
  try {
    await api('POST', `/api/reset/${encodeURIComponent(linkToken)}`, { password: $('resetPass').value });
    await whoAmI();
    await showApp();
  } catch (e) { $('resetMsg').textContent = e.message; }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  $('authUser').value = user || '';
  document.querySelector('.menu').open = false;
  showAuth(false);
});
$('pwBtn').addEventListener('click', () => {
  document.querySelector('.menu').open = false;
  $('pwForm').reset(); $('pwUser').value = user || ''; $('pwMsg').textContent = '';
  $('pwDialog').showModal();
});
$('pwCancel').addEventListener('click', () => $('pwDialog').close());
$('pwForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if ($('pwNew').value !== $('pwNew2').value) { $('pwMsg').textContent = 'New passwords don’t match.'; return; }
  try {
    await api('POST', '/api/password', { current: $('pwCurrent').value, password: $('pwNew').value });
    $('pwDialog').close();
  } catch (e) { $('pwMsg').textContent = e.message; }
});

// My account (or, for the admin, editing someone else)
let accountTarget = null; // null = me
function openAccount(u, isSelf) {
  accountTarget = isSelf ? null : u.id;
  $('accountTitle').textContent = isSelf ? 'My account' : `Edit ${u.firstName || u.user}`;
  $('accFirst').value = u.firstName || '';
  $('accLast').value = u.lastName || '';
  $('accUser').value = u.user;
  $('accEmail').value = u.email || '';
  $('accEmail').dataset.original = u.email || '';
  $('accCurrent').value = '';
  $('accCurrentWrap').hidden = true;
  $('accountMsg').textContent = '';
  $('accountDialog').showModal();
}
$('accEmail').addEventListener('input', () => {
  $('accCurrentWrap').hidden = accountTarget !== null || $('accEmail').value.trim() === $('accEmail').dataset.original;
});
$('accountBtn').addEventListener('click', () => {
  document.querySelector('.menu').open = false;
  openAccount(state.me, true);
});
$('accountCancel').addEventListener('click', () => $('accountDialog').close());
$('accountForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = { firstName: $('accFirst').value.trim(), lastName: $('accLast').value.trim(), email: $('accEmail').value.trim() };
  try {
    if (accountTarget) {
      await api('PUT', `/api/users/${encodeURIComponent(accountTarget)}`, body);
      await renderUsers();
    } else {
      state.me = await api('PUT', '/api/me', { ...body, current: $('accCurrent').value });
      firstName = state.me.firstName;
      $('whoami').textContent = `Signed in as ${firstName ? `${firstName} (${user})` : user}`;
    }
    $('accountDialog').close();
  } catch (e) { $('accountMsg').textContent = e.message; }
});

// ---------- rendering ----------
function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return fmtShort(t);
}
function renderSync() {
  const s = state.sync || { enabled: false };
  const el = $('syncStatus');
  const bad = s.enabled && !!s.lastError;
  el.className = `small${bad ? ' bad' : ''}`;
  el.textContent = !s.enabled ? 'Database backup: off'
    : bad ? `Database backup failing: ${s.lastError}`
    : s.lastOk ? `Backed up to database ${timeAgo(s.lastOk)}` : 'Database backup: starting…';
  $('syncDot').hidden = !bad;
}

function renderVersion() {
  const v = state.version;
  if (!v) { $('versionLine').textContent = ''; return; }
  $('versionLine').innerHTML = `PeptideTracker v${esc(v.current)}${v.latest
    ? ` · <a href="${esc(v.url)}" target="_blank" rel="noopener">v${esc(v.latest)} available</a><br><span class="muted">Update: type <code>update</code> in the container’s console</span>` : ''}`;
}
$('disclaimerDialog').addEventListener('cancel', ev => ev.preventDefault()); // must be acknowledged
$('disclaimerForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try { await api('PUT', '/api/settings', { disclaimerOk: true }); state.settings.disclaimerOk = true; } catch {}
  $('disclaimerDialog').close();
});
function render() {
  document.querySelectorAll('.u').forEach(el => (el.textContent = unit()));
  $('unit').value = unit();
  const { goal, goalDate } = state.settings;
  if (document.activeElement !== $('goal')) $('goal').value = goal != null ? fmtNum(goal) : '';
  if (document.activeElement !== $('goalDate')) $('goalDate').value = goalDate ? localDateValue(goalDate) : '';

  const proj = project(state.entries, goal);
  renderHero(proj);
  renderStats(proj);
  renderChart(proj);
  const showShots = state.settings.showShots !== false;
  $('shotCard').hidden = !showShots;
  applyLayout();
  renderNext();
  renderShots();
  renderBanners();
  renderInventory();
  renderMeds();
  renderProgress();
  renderDoseResults();
  $('photosBtn').hidden = state.settings.photos !== true;
  renderSync();
  renderVersion();
  renderHistory();
  if (!state.settings.disclaimerOk && !$('disclaimerDialog').open) $('disclaimerDialog').showModal();
}

function renderHero(proj) {
  const { entries } = state;
  const { goal, goalDate } = state.settings;
  let html;
  if (!entries.length) {
    html = `<div class="big">Log your first weigh-in</div><div class="sub">Then set a goal weight to get a projected date.</div>`;
  } else if (proj.status === 'insufficient') {
    html = `<div class="big">Keep logging</div><div class="sub">${esc(proj.reason)} Then you'll get a projected goal date.</div>`;
  } else if (goal == null) {
    html = `<div class="big">${signed(proj.recent.perWeek)} ${unit()}/week</div><div class="sub">Your recent pace. Set a goal weight below to see when you'll reach it.</div>`;
  } else {
    const r = proj.recent, o = proj.overall;
    if (r.status === 'reached') {
      html = `<div class="big">Goal reached</div><div class="sub">Your trend is at ${fmtW(r.trendWeight)}, at or past your goal of ${fmtW(goal)}.</div>`;
    } else if (r.status === 'wrong-direction') {
      html = `<div class="big">No date yet</div><div class="sub">Your recent trend (${signed(r.perWeek)} ${unit()}/week) isn't moving toward ${fmtW(goal)}. Keep logging — it will update.</div>`;
    } else {
      html = `<div class="sub">Projected to reach ${fmtW(goal)} on</div>
        <div class="big">${fmtDate(r.date)}</div>
        <div class="sub">About ${timeAway(r.date)} away at your recent pace of ${signed(r.perWeek)} ${unit()}/week.</div>`;
      if (o.status === 'ok' && Math.abs(o.date - r.date) > DAY) {
        html += `<div class="alt">Using all your data equally: ${fmtDate(o.date)} (${signed(o.perWeek)} ${unit()}/week).</div>`;
      }
    }
    if (goalDate && r.status !== 'reached') {
      const need = requiredPace(r.trendWeight, goal, goalDate, Date.now());
      if (need != null) {
        const onTrack = r.status === 'ok' && r.date <= goalDate + DAY;
        html += `<div class="alt">To hit it by ${fmtDate(goalDate)} you need ${signed(need)} ${unit()}/week — ${onTrack ? 'you’re on track.' : 'you’re behind that pace.'}</div>`;
      } else {
        html += `<div class="alt">Your target date (${fmtDate(goalDate)}) has passed.</div>`;
      }
    }
  }
  $('hero').innerHTML = html;
}

function renderStats(proj) {
  const { entries } = state;
  const { goal } = state.settings;
  if (!entries.length) { $('stats').innerHTML = ''; return; }
  const first = entries[0], last = entries[entries.length - 1];
  const tiles = [
    ['Current', fmtW(last.weight)],
    ['Total change', `${signed(last.weight - first.weight)} ${unit()}`],
    ['Recent pace', proj.status === 'ok' ? `${signed(proj.recent.perWeek)}/wk` : '—'],
    ['To goal', goal != null ? `${Math.abs(toDisp(last.weight - goal)).toFixed(1)} ${unit()}` : '—'],
  ];
  $('stats').innerHTML = tiles.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

function niceTicks(min, max, count = 5) {
  const raw = (max - min || 1) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

function renderChart(proj) {
  const svg = $('chart');
  const { entries, shots } = state;
  const changes = state.settings.showShots === false ? [] : doseChanges(mainList());
  const { goal } = state.settings;
  const W = svg.clientWidth || 600, H = svg.clientHeight || 280;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!entries.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Your chart will appear here</text>`;
    svg.onpointermove = svg.onpointerleave = null;
    $('chartKey').innerHTML = '';
    return;
  }

  const r = proj.status === 'ok' ? proj.recent : null;
  const hasProj = r && r.status === 'ok';
  const firstMed = changes.length ? changes[0].t : Infinity;
  const t0 = Math.min(entries[0].t, firstMed), tLast = entries[entries.length - 1].t;
  // Show the projection, but don't let a far-off date squash your history.
  const cap = tLast + Math.max(200 * DAY, (tLast - t0) * 1.5);
  let tMax = tLast;
  if (hasProj) tMax = Math.min(r.date, cap);
  if (state.settings.goalDate && state.settings.goalDate > tMax) tMax = Math.min(state.settings.goalDate, cap);
  if (tMax - t0 < DAY) tMax = t0 + DAY;
  tMax += (tMax - t0) * 0.02; // breathing room for the end marker

  const vals = entries.map(e => toDisp(e.weight));
  if (goal != null) vals.push(toDisp(goal));
  let yMin = Math.min(...vals), yMax = Math.max(...vals);
  const pad = Math.max((yMax - yMin) * 0.08, 1);
  yMin -= pad; yMax += pad;
  const yt = niceTicks(yMin, yMax, 5);
  yMin = Math.min(yMin, yt[0]); yMax = Math.max(yMax, yt[yt.length - 1]);

  // Dose labels sit in rows above the plot; bump a label down a row if it would overlap.
  const doseMarks = changes.filter(c => c.t <= tMax);
  const m = { l: 40, r: 14, t: 12, b: 26 };
  const x = t => m.l + ((t - t0) / (tMax - t0)) * (W - m.l - m.r);
  const rowEnds = [];
  const placed = doseMarks.map(med => {
    const label = `${trim(med.doseMg)} mg`;
    const lx = x(med.t) + 4, width = label.length * 6 + 4;
    let row = rowEnds.findIndex(end => end < lx);
    if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
    rowEnds[row] = lx + width;
    return { med, label, lx, row };
  });
  if (placed.length) m.t = 8 + rowEnds.length * 14;
  const y = v => m.t + (1 - (v - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  let s = '';
  for (const v of yt) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    s += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v % 1 ? v.toFixed(1) : v}</text>`;
  }
  const nx = Math.max(2, Math.min(6, Math.floor((W - m.l - m.r) / 90)));
  for (let i = 0; i <= nx; i++) {
    const t = t0 + ((tMax - t0) * i) / nx;
    const anchor = i === 0 ? 'start' : i === nx ? 'end' : 'middle';
    s += `<text x="${x(t)}" y="${H - 6}" text-anchor="${anchor}">${fmtShort(t)}</text>`;
  }
  // Dose change markers
  for (const p of placed) {
    const px = x(p.med.t);
    s += `<line x1="${px}" x2="${px}" y1="${6 + p.row * 14}" y2="${H - m.b}" stroke="var(--series-2)" stroke-width="1.5" stroke-dasharray="3 3" opacity=".75"/>`;
    s += `<text class="dose-label" x="${p.lx}" y="${15 + p.row * 14}">${esc(p.label)}</text>`;
  }
  if (goal != null) {
    const gy = y(toDisp(goal));
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${gy}" y2="${gy}" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="2 4"/>`;
    s += `<text class="label" x="${m.l + 6}" y="${gy - 6}">Goal ${fmtNum(goal)}</text>`;
  }
  if (hasProj) {
    const endT = Math.min(r.date, tMax);
    const endV = toDisp(r.trendWeight) + (toDisp(goal) - toDisp(r.trendWeight)) * ((endT - r.fromT) / (r.date - r.fromT));
    s += `<line x1="${x(r.fromT)}" y1="${y(toDisp(r.trendWeight))}" x2="${x(endT)}" y2="${y(endV)}" stroke="var(--series-1)" stroke-width="2" stroke-dasharray="6 5" opacity=".75"/>`;
    if (r.date <= tMax) {
      s += `<circle cx="${x(endT)}" cy="${y(endV)}" r="5" fill="var(--surface-1)" stroke="var(--series-1)" stroke-width="2"/>`;
      s += `<text class="label" x="${x(endT)}" y="${y(endV) + 18}" text-anchor="end">${fmtShort(r.date)}</text>`;
    }
  }
  const pts = entries.map(e => [x(e.t), y(toDisp(e.weight))]);
  // Daily weigh-ins stay visible but quiet; the 7-day average carries the trend.
  const avgData = movingAverage(entries);
  const avg = avgData.map(a => [x(a.t), y(toDisp(a.avg))]);
  const showAvg = entries.length >= 5;
  s += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--series-1)" stroke-width="${showAvg ? 1 : 2}" opacity="${showAvg ? 0.35 : 1}" stroke-linejoin="round"/>`;
  const dotR = entries.length > 60 ? 2.5 : 3.5;
  s += pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="${dotR}" fill="var(--series-1)" opacity="${showAvg ? 0.55 : 1}" stroke="var(--surface-1)" stroke-width="1"/>`).join('');
  if (showAvg) s += `<polyline points="${avg.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--series-1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  s += `<line id="xhair" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-muted)" stroke-width="1" visibility="hidden"/>`;
  s += `<circle id="hdot" r="6" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2" visibility="hidden"/>`;
  svg.innerHTML = s;

  $('chartKey').innerHTML = (showAvg
      ? `<span class="key"><span class="swatch"></span>7-day average</span><span class="key"><span class="swatch thin"></span>Daily weigh-ins</span>`
      : `<span class="key"><span class="swatch"></span>Weight</span>`)
    + (hasProj ? `<span class="key"><span class="swatch dash"></span>Projection</span>` : '')
    + (placed.length ? `<span class="key"><span class="swatch dose"></span>Dose change</span>` : '');

  const tip = $('tip');
  svg.onpointermove = ev => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p[0] - px) < Math.abs(pts[best][0] - px)) best = i; });
    const [bx, by] = pts[best], e = entries[best];
    $('xhair').setAttribute('x1', bx); $('xhair').setAttribute('x2', bx); $('xhair').setAttribute('visibility', 'visible');
    $('hdot').setAttribute('cx', bx); $('hdot').setAttribute('cy', by); $('hdot').setAttribute('visibility', 'visible');
    const med = state.settings.showShots === false ? null : shotAt(mainList(), e.t);
    tip.innerHTML = `<b>${fmtW(e.weight)}</b> · ${fmtShort(e.t)}`
      + (showAvg ? `<br>7-day avg ${fmtW(avgData[best].avg)}` : '')
      + (med ? `<br>${esc(shotLabel(med))}` : '')
      + (e.note ? `<br>${esc(e.note)}` : '');
    tip.style.left = `${Math.min(Math.max((bx / W) * rect.width, 70), rect.width - 70)}px`;
    tip.style.top = `${(by / H) * rect.height}px`;
    tip.classList.add('show');
  };
  svg.onpointerleave = () => {
    tip.classList.remove('show');
    $('xhair')?.setAttribute('visibility', 'hidden');
    $('hdot')?.setAttribute('visibility', 'hidden');
  };
}

// ---------- shots & vials ----------
const supplyById = id => state.supplies.find(s => s.id === id) || null;
function supplyLabel(s) {
  if (!s) return 'Other / not tracked';
  const size = s.kind === 'vial' ? (s.mg ? `${trim(s.mg)} mg vial` : 'vial') : `${s.count ? `${s.count}-pack` : 'pens'}`;
  return `${s.name} ${size} (${fmtShort(s.opened)})`;
}

function renderPlan() {
  if (!planOn()) {
    $('planView').innerHTML = `<div class="plan-note">Want the app to recommend your dose and step it up on schedule? <a href="#" class="linkish" data-action="settings">Set up a dose plan</a></div>`;
    return;
  }
  const { steps, rec, plan } = dosePlan(mainList(), state.settings.plan, nextShotAt());
  const conc = currentConc();
  const tag = { done: 'Done', current: 'Now', next: 'Next', planned: 'Planned' };
  const rows = steps.map(st => {
    const when = st.status === 'done' || st.status === 'current'
      ? `${fmtShort(st.startAt)} · ${st.shots} shot${st.shots === 1 ? '' : 's'}${st.status === 'current' && st.remaining ? ` (${st.remaining} to go)` : ''}`
      : `from ${fmtDay(st.startAt)}`;
    const units = conc ? `${trim(mgToUnits(st.doseMg, conc))} u` : '';
    return `<tr class="${st.status}"><td>${trim(st.doseMg)} mg${st.doseMg >= plan.maxDose ? ' <span class="muted small">(max)</span>' : ''}</td><td>${when}</td><td class="num">${units}</td><td class="num"><span class="tag">${tag[st.status]}</span></td></tr>`;
  }).join('');
  $('planView').innerHTML = `<div class="plan-note">Next shot: <b>${trim(rec.doseMg)} mg</b>${conc ? ` = ${trim(mgToUnits(rec.doseMg, conc))} units` : ''}. ${esc(rec.reason)}.</div>
    <table class="plan-table"><tbody>${rows}</tbody></table>
    <p class="muted small help">Units are for your current vial${conc ? ` (${trim(conc)} mg/mL)` : ''}. Future dates assume weekly shots. Step up ${trim(plan.step)} mg after every ${plan.every} shots, up to ${trim(plan.maxDose)} mg.</p>`;
}
$('planView').addEventListener('click', ev => {
  if (ev.target.closest('[data-action="settings"]')) { ev.preventDefault(); openSettings(); }
});

// The schedule's dose in mg (units are converted with the vial strength the schedule was set on).
function protoTargetMg(p, amount, fallbackConc) {
  if (p.unit === 'mg') return amount;
  const ref = p.refConc || fallbackConc;
  return ref ? unitsToMg(amount, ref) : null;
}
const concDiffers = (a, b) => a && b && Math.abs(a - b) / b > 0.01;
function protoDoseText(p) {
  const rec = protocolDose(p, doses());
  const conc = concentration(vialToUse(p.name));
  const mg = protoTargetMg(p, rec.amount, conc);
  let txt;
  if (mg == null) txt = fmtAmount(rec.amount, p.unit);
  else if (!conc) txt = fmtMg(mg);
  else txt = `${trim(mgToUnits(mg, conc))} units (${fmtMg(mg)})`;
  const stronger = p.unit === 'units' && concDiffers(conc, p.refConc);
  if (stronger) txt += ` — converted for this vial’s strength`;
  return { rec, txt, mg, conc };
}
function protoWhen(p) {
  const st = protocolStatus(p, doses(), Date.now());
  if (st.state === 'done-today') return '✓ Done today';
  if (st.state === 'due-today') return '<b>Due today</b>';
  if (st.state === 'overdue') return `<b>Overdue</b> — was due ${fmtDay(st.due)}`;
  if (st.state === 'as-needed') return 'As needed';
  return st.due ? `Next: ${fmtDay(st.due)}` : '';
}
function renderProtocols() {
  const list = protocols();
  $('protoWrap').hidden = !list.length;
  $('protoView').innerHTML = list.map(p => {
    const { rec, txt } = protoDoseText(p);
    const vial = openVialFor(p.name);
    const t = p.titrate || {};
    const inc = t.enabled && rec.untilIncrease ? ` · increases in ${rec.untilIncrease} dose${rec.untilIncrease === 1 ? '' : 's'}` : rec.atMax ? ' · at max' : '';
    return `<div class="proto">
      <div class="pname">${esc(p.name)}</div>
      <div class="pmeta">${esc(describeProtocol(p, fmtAmount))}</div>
      <div class="pnext">${protoWhen(p)} · next dose <b>${esc(txt)}</b>${inc}${vial ? '' : ' · <span class="muted">no open vial</span>'}</div>
      <div class="btns">
        <button type="button" class="act" data-log-med="${esc(p.name)}">Log</button>
        <button type="button" class="act" data-edit-med="${esc(p.name)}">Edit</button>
      </div>
    </div>`;
  }).join('');
}
$('protoView').addEventListener('click', ev => {
  const log = ev.target.closest('[data-log-med]');
  const edit = ev.target.closest('[data-edit-med]');
  if (log) openShotDialog(null, { med: log.dataset.logMed });
  if (edit) {
    const name = edit.dataset.editMed;
    const vial = openVialFor(name) || [...state.supplies].reverse().find(v => v.name.toLowerCase() === name.toLowerCase());
    openSupplyDialog(vial || null, vial ? null : name);
  }
});

function renderShots() {
  renderPlan();
  renderProtocols();
  const { supplies, shots } = state;
  $('medNames').innerHTML = [...new Set([...supplies, ...shots].map(m => m.name))].map(n => `<option value="${esc(n)}">`).join('');

  // Summary (main GLP-1)
  const main = mainList();
  const last = main[main.length - 1];
  if (!last) {
    $('shotSummary').innerHTML = shots.length
      ? `<div class="med-current"><div class="sub small muted">${money0(totalSpent(supplies))} spent total</div></div>`
      : `<div class="empty">Add a vial, then log each shot to track what's left and what each dose costs.</div>`;
  } else {
    const sup = supplyById(last.supplyId);
    const cost = shotCost(last, sup);
    const st = shotStatus(main, state.settings.shotDay, Date.now());
    const due = st.due ?? nextShotDue(main);
    const daysToDue = Math.round((startOfDay(due) - startOfDay(Date.now())) / DAY);
    const dueText = daysToDue < 0 ? `was due ${fmtDay(due)}` : daysToDue === 0 ? 'due today' : daysToDue === 1 ? 'due tomorrow' : `due ${fmtDay(due)}`;
    const parts = [`Last shot ${fmtDay(last.t)}`, `next ${dueText}${state.settings.shotDay != null ? ` (every ${WEEKDAYS[state.settings.shotDay]})` : ''}`];
    const money1 = [];
    if (cost != null) money1.push(`${money(cost)} per shot`, `≈ ${money0(cost * 52 / 12)}/month`);
    money1.push(`${money0(totalSpent(supplies))} spent total`);
    $('shotSummary').innerHTML = `<div class="med-current">
      <div class="muted small">Current dose</div>
      <div class="big">${esc(shotLabel(last))}${last.units != null ? ` = ${trim(last.units)} units` : ''}</div>
      <div class="sub">${parts.join(' · ')}</div>
      <div class="sub small muted">${money1.join(' · ')}</div>
    </div>`;
  }

  // Vials, active first; finished ones folded away.
  const active = supplies.filter(s => !s.done).reverse();
  const finished = supplies.filter(s => s.done).reverse();
  const card = s => {
    const u = usage(s, shots);
    const conc = concentration(s);
    const meta = [];
    if (s.kind === 'vial') {
      if (s.mg && s.waterMl) meta.push(`${trim(s.mg)} mg + ${trim(s.waterMl)} mL = <b>${trim(conc)} mg/mL</b>`);
      else meta.push('Add powder mg and water to track what’s left');
    } else if (s.count) meta.push(`${s.count} doses`);
    if (s.price != null) meta.push(money(s.price));
    let left = '';
    if (s.kind === 'vial' && u.leftMg != null) {
      left = conc
        ? `<b>${trim(u.leftMl)} mL</b> left (${trim(u.leftUnits)} units · ${trim(u.leftMg)} mg)`
        : `<b>${trim(u.leftMg)} mg</b> left`;
      if (u.shotsLeft != null) left += ` · about <b>${u.shotsLeft}</b> more ${trim(u.atDoseMg)} mg shot${u.shotsLeft === 1 ? '' : 's'}`;
      const ub = !s.done && useBy(state, s);
      if (ub) left += `<br><span class="${ub.daysLeft <= 0 || ub.wontFinish ? 'warn-tag' : 'muted'}">${useByText(ub)}</span>`;
    } else if (s.kind === 'pack' && u.left != null) {
      left = `<b>${u.left}</b> of ${s.count} left`;
    } else {
      left = '';
    }
    left = [left, takenText(s)].filter(Boolean).join('<br>');
    const lastFrom = [...shots].reverse().find(x => x.supplyId === s.id);
    const chips = [];
    if (lastFrom && conc) chips.push(`${trim(lastFrom.doseMg)} mg = <b>${trim(mgToUnits(lastFrom.doseMg, conc))} units</b>`);
    const c = lastFrom ? shotCost(lastFrom, s) : null;
    if (c != null) chips.push(`<b>${money(c)}</b> per ${trim(lastFrom.doseMg)} mg shot`);
    const frac = u.fraction ?? null;
    return `<div class="supply">
      <div class="supply-name">${esc(supplyLabel(s))}${s.done ? '<span class="badge">Finished</span>' : ''}</div>
      <div class="supply-meta">${s.kind === 'vial' ? 'Mixed' : 'Started'} ${fmtShort(s.opened)} · ${meta.join(' · ')}</div>
      <button class="edit" type="button" data-supply="${esc(s.id)}">Edit</button>
      ${frac != null && !s.done ? `<div class="bar${frac < 0.25 ? ' low' : ''}" role="img" aria-label="${Math.round(frac * 100)}% left"><span style="width:${(frac * 100).toFixed(1)}%"></span></div>` : ''}
      <div class="left">${left}</div>
      ${chips.length ? `<div class="chips">${chips.map(x => `<span class="chip">${x}</span>`).join('')}</div>` : ''}
      ${s.note ? `<div class="med-note">${esc(s.note)}</div>` : ''}
    </div>`;
  };
  $('supplyList').innerHTML = (active.length ? active.map(card).join('') : `<div class="empty">No open vials. Tap “+ Vial” when you mix a new one.</div>`)
    + (finished.length ? `<details class="finished"><summary>Finished (${finished.length})</summary>${finished.map(card).join('')}</details>` : '');

  // Shots, newest first (a dose split across two vials shows as one)
  const list = doses().reverse();
  const shown = showAllShots ? list : list.slice(0, 5);
  $('shotList').innerHTML = list.length
    ? shown.map(x => {
      const parts = x.parts || [x];
      const costs = parts.map(pt => shotCost(pt, supplyById(pt.supplyId)));
      const c = costs.every(v => v != null) ? costs.reduce((a, b) => a + b, 0) : null;
      const from = parts.length > 1
        ? parts.map(pt => `${fmtMg(pt.doseMg)} from ${supplyLabel(supplyById(pt.supplyId))}`).join(' + ')
        : supplyLabel(supplyById(x.supplyId));
      return `<div class="shot">
        <div class="what">${esc(shotLabel(x))}${x.units != null ? ` · ${trim(x.units)} units` : ''}${x.site ? ` · ${esc(x.site)}` : ''}</div>
        <div class="meta">${fmtDay(x.t)} ${fmtTime(x.t)} · ${esc(from)}${c != null ? ` · ${money(c)}` : ''}${x.note ? ` · ${esc(x.note)}` : ''}</div>
        <button class="act edit" type="button" data-shot="${esc(x.id)}">Edit</button>
      </div>`;
    }).join('') + (list.length > 5 ? `<button class="linkish" id="moreShots" type="button">${showAllShots ? 'Show recent only' : `Show all ${list.length}`}</button>` : '')
    : `<div class="empty">No shots logged yet.</div>`;
}

function renderHistory() {
  const { entries, shots } = state;
  $('count').textContent = entries.length ? `${entries.length} weigh-in${entries.length === 1 ? '' : 's'}` : '';
  if (!entries.length && !shots.length) { $('history').innerHTML = '<div class="empty">No weigh-ins yet.</div>'; return; }

  // Weigh-ins and dose changes together, newest first.
  const rows = [];
  entries.forEach((e, i) => rows.push({ t: e.t, html: entryRow(e, entries[i - 1]) }));
  (state.settings.showShots === false ? [] : doseChanges(mainList())).forEach(m => rows.push({ t: m.t, html: `<tr class="dose-row"><td colspan="4">${fmtDay(m.t)} — first <b>${esc(shotLabel(m))}</b> shot${m.units != null ? ` (${trim(m.units)} units)` : ''}</td></tr>` }));
  rows.sort((a, b) => b.t - a.t);
  const shown = showAll ? rows : rows.slice(0, 15);
  const more = rows.length > 15
    ? `<button class="linkish" id="moreBtn" type="button">${showAll ? 'Show recent only' : `Show all ${rows.length}`}</button>` : '';
  $('history').innerHTML = `<table><thead><tr><th>Date</th><th class="num">${unit()}</th><th class="num">Change</th><th></th></tr></thead><tbody>${shown.map(r => r.html).join('')}</tbody></table>${more}`;
}

function entryRow(e, prev) {
  return `<tr>
    <td>${fmtDay(e.t)} <span class="muted small">${fmtTime(e.t)}</span>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</td>
    <td class="num">${fmtNum(e.weight)}</td>
    <td class="num">${prev ? signed(e.weight - prev.weight) : '—'}</td>
    <td class="actions">
      <button class="act edit-entry" data-id="${esc(e.id)}" type="button" aria-label="Edit ${fmtDay(e.t)}">Edit</button>
      <button class="act del" data-id="${esc(e.id)}" type="button" aria-label="Delete ${fmtDay(e.t)}">✕</button>
    </td>
  </tr>`;
}

// ---------- weigh-in form (add + edit) ----------
function setEditMode(entry) {
  editingEntryId = entry ? entry.id : null;
  $('logCard').classList.toggle('editing', !!entry);
  $('logTitle').textContent = entry ? 'Edit weigh-in' : 'Log weight';
  $('logBtn').textContent = entry ? 'Update' : 'Save';
  $('editBar').hidden = !entry;
  $('weight').value = entry ? fmtNum(entry.weight) : '';
  $('note').value = entry ? entry.note || '' : '';
  $('when').value = localInputValue(entry ? entry.t : Date.now());
  $('logMsg').textContent = '';
}

$('logForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('logMsg').textContent = '';
  const v = parseFloat($('weight').value);
  const t = new Date($('when').value).getTime();
  if (!Number.isFinite(v) || v <= 0) { $('logMsg').textContent = 'Enter a weight.'; return; }
  if (!Number.isFinite(t)) { $('logMsg').textContent = 'Enter a date and time.'; return; }
  const body = { weight: fromDisp(v), t, note: $('note').value.trim() };
  try {
    if (editingEntryId) await api('PUT', `/api/entries/${encodeURIComponent(editingEntryId)}`, body);
    else await api('POST', '/api/entries', body);
    setEditMode(null);
    await refresh();
  } catch (e) { $('logMsg').textContent = e.message; }
});
$('cancelEdit').addEventListener('click', () => setEditMode(null));

$('history').addEventListener('click', async ev => {
  if (ev.target.id === 'moreBtn') { showAll = !showAll; renderHistory(); return; }
  const edit = ev.target.closest('.edit-entry');
  if (edit) {
    setEditMode(state.entries.find(e => e.id === edit.dataset.id));
    $('logCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('weight').focus({ preventScroll: true });
    return;
  }
  const del = ev.target.closest('.del');
  if (del && confirm('Delete this weigh-in?')) {
    await api('DELETE', `/api/entries/${encodeURIComponent(del.dataset.id)}`);
    if (editingEntryId === del.dataset.id) setEditMode(null);
    await refresh();
  }
});

// ---------- vial dialog ----------
const numOrNull = id => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
const supplyKind = () => document.querySelector('input[name="sKind"]:checked').value;

function readSupplyForm() {
  const kind = supplyKind();
  return {
    name: $('sName').value.trim(),
    kind,
    mg: kind === 'vial' ? numOrNull('sMg') : null,
    waterMl: kind === 'vial' ? numOrNull('sWater') : null,
    count: kind === 'pack' ? numOrNull('sCount') : null,
    price: numOrNull('sPrice'),
    useWithin: kind === 'vial' && numOrNull('sUseWithin') ? Math.round(numOrNull('sUseWithin')) : null,
    opened: $('sOpened').value ? dateInputToMs($('sOpened').value) : null,
    done: $('sDone').checked,
    note: $('sNote').value.trim(),
  };
}

function updateSupplyCalc() {
  const kind = supplyKind();
  document.querySelectorAll('#supplyForm .vial-only').forEach(el => (el.hidden = kind !== 'vial'));
  document.querySelectorAll('#supplyForm .pack-only').forEach(el => (el.hidden = kind !== 'pack'));
  $('sOpenedLabel').textContent = kind === 'vial' ? 'Date mixed' : 'Date started';
  const s = readSupplyForm();
  const conc = concentration(s);
  const out = [];
  if (conc) {
    out.push(`<div class="line hl"><span>Strength</span><b>${trim(conc)} mg/mL</b></div>`);
    const doses = [2.5, 5, 7.5, 10, 12.5, 15].filter(d => d <= s.mg);
    if (!protocolFor(protocols(), $('sName').value)) out.push(`<div class="muted small">Units to draw (U-100 syringe):</div><div class="units-table">${doses.map(d => `<span>${d} mg = <b>${trim(mgToUnits(d, conc))}</b></span>`).join('')}</div>`);
    if (s.price) out.push(`<div class="line"><span>Cost per mg</span><b>${money(s.price / s.mg)}</b></div>`);
  } else if (kind === 'pack' && s.count && s.price) {
    out.push(`<div class="line hl"><span>Cost per dose</span><b>${money(s.price / s.count)}</b></div>`);
  }
  $('supplyCalc').innerHTML = out.join('') || `<span class="muted">${kind === 'vial' ? 'Enter powder mg and water mL to see the strength and units per dose.' : 'Enter doses and price to see cost per dose.'}</span>`;
}

// ---------- schedule fields (in the medication editor) ----------
const schedMode = () => document.querySelector('input[name="sSched"]:checked')?.value || 'main';
function defaultSchedMode(name) {
  if (!name) return 'main';
  if (protocolFor(protocols(), name)) return 'own';
  if (extrasFor(name).kind) return extrasFor(name).kind;
  const known = state.shots.some(x => lc(x.name) === lc(name));
  // A medication you've never logged before is probably an extra one, unless you have no main GLP-1 yet.
  return known || !mainList().length ? 'main' : 'own';
}
// Strength used for the schedule preview: the vial defaults typed in the editor, else the vial in use.
function editorConc(name) {
  const mg = numOrNull('mdVialMg'), w = numOrNull('mdVialWater');
  if (mg > 0 && w > 0) return mg / w;
  return concentration(vialToUse(name));
}
function fillSched(name) {
  const p = protocolFor(protocols(), name) || { freq: 'daily', days: [], everyN: 2, start: Date.now(), unit: 'units', amount: '', titrate: { enabled: false, every: 7 } };
  $('pFreq').value = p.freq;
  $('pDays').innerHTML = WEEKDAYS_SHORT.map((d, i) => `<label><input type="checkbox" name="pDay" value="${i}"${(p.days || []).includes(i) ? ' checked' : ''}> ${d}</label>`).join('');
  $('pEvery').value = p.everyN || 2;
  $('pStart').value = localDateValue(p.start || Date.now());
  $('pAmount').value = p.amount ?? '';
  $('pUnit').value = p.unit || 'units';
  // Existing schedule: its strength. New one: the vial strength (until you type your own).
  const c = editorConc(name);
  $('pRefConc').value = p.refConc ? trimMg(p.refConc) : (c ? trimMg(c) : '');
  $('pRefConc').dataset.auto = p.refConc ? '' : '1';
  $('pTitrate').checked = !!p.titrate?.enabled;
  $('pStep').value = p.titrate?.step ?? '';
  $('pStepEvery').value = p.titrate?.every ?? 7;
  $('pMax').value = p.titrate?.max || '';
}
function readSched(name) {
  const titrate = $('pTitrate').checked
    ? { enabled: true, step: numOrNull('pStep'), every: numOrNull('pStepEvery'), max: numOrNull('pMax') ?? 0 }
    : { enabled: false };
  return {
    name, freq: $('pFreq').value,
    days: [...document.querySelectorAll('input[name="pDay"]:checked')].map(x => Number(x.value)),
    everyN: numOrNull('pEvery'),
    start: $('pStart').value ? dateInputToMs($('pStart').value) - 12 * 3600000 : null, // start of that day
    unit: $('pUnit').value, amount: numOrNull('pAmount'), titrate,
    refConc: $('pUnit').value === 'units' ? numOrNull('pRefConc') : null,
  };
}
function updateSched() {
  const name = $('mdName').value.trim();
  const own = schedMode() === 'own';
  $('schedFields').hidden = !own;
  $('mainFields').hidden = own;
  $('planBody').hidden = !$('planOn').checked;
  if (!own) return;
  $('pDaysWrap').hidden = $('pFreq').value !== 'days';
  $('pEveryWrap').hidden = $('pFreq').value !== 'every';
  $('pTitrateFields').hidden = !$('pTitrate').checked;
  $('pRefWrap').hidden = $('pUnit').value !== 'units';
  const conc = editorConc(name);
  if ($('pRefConc').dataset.auto === '1' && conc) $('pRefConc').value = trimMg(conc);
  const p = readSched(name);
  const lines = [];
  if (p.amount > 0) {
    lines.push(`<div class="line hl"><span>Schedule</span><b>${esc(describeProtocol({ ...p, everyN: p.everyN || 1 }, fmtAmount))}</b></div>`);
    const doseMgRef = protoTargetMg(p, p.amount, conc);
    if (doseMgRef != null) lines.push(`<div class="line"><span>Each dose</span><b>${fmtMg(doseMgRef)}</b></div>`);
    if (conc) {
      const doseMg = doseMgRef ?? (p.unit === 'units' ? unitsToMg(p.amount, conc) : p.amount);
      lines.push(`<div class="line"><span>From a ${trim(conc)} mg/mL vial</span><b>${trim(mgToUnits(doseMg, conc))} units</b></div>`);
      const vialMg = numOrNull('mdVialMg') || vialToUse(name)?.mg;
      if (vialMg && doseMg > 0) lines.push(`<div class="line"><span>Doses per vial (at this dose)</span><b>${Math.floor(vialMg / doseMg + 1e-9)}</b></div>`);
    }
  }
  $('schedPreview').innerHTML = lines.join('') || '<span class="muted">Enter the dose to see the schedule.</span>';
}
document.querySelectorAll('input[name="sSched"]').forEach(r => r.addEventListener('change', updateSched));
$('schedFields').addEventListener('input', updateSched);
$('schedFields').addEventListener('change', updateSched);
$('pRefConc').addEventListener('input', () => { $('pRefConc').dataset.auto = ''; });
$('planOn').addEventListener('change', updateSched);

// Spot near-misses like "Tirzepitade" vs "Tirzepatide", which would split one medication in two.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function similarName(name) {
  const n = name.trim().toLowerCase();
  if (n.length < 4) return null;
  const known = [...new Set([...state.supplies, ...state.shots, ...protocols(), ...Object.values(state.settings.medExtras || {})].map(x => x.name.trim()))];
  if (known.some(k => k.toLowerCase() === n)) return null;
  let best = null;
  for (const k of known) {
    const dist = editDistance(n, k.toLowerCase());
    if (dist <= 2 && (!best || dist < best.dist)) best = { name: k, dist };
  }
  return best?.name || null;
}
function nameHint(inputId, hintId) {
  const s = similarName($(inputId).value);
  $(hintId).hidden = !s;
  $(hintId).innerHTML = s ? `Did you mean <button type="button" class="linkish" data-name="${esc(s)}">${esc(s)}</button>? Different spellings are tracked as different medications.` : '';
}
const updateNameHint = () => nameHint('sName', 'sNameHint');
for (const [inputId, hintId] of [['sName', 'sNameHint'], ['mdName', 'mdNameHint']]) {
  $(hintId).addEventListener('click', ev => {
    const b = ev.target.closest('[data-name]');
    if (!b) return;
    $(inputId).value = b.dataset.name;
    $(inputId).dispatchEvent(new Event('input'));
  });
}

// ---------- vial screen: medication summary + defaults ----------
function updateVialSchedLine() {
  const name = $('sName').value.trim();
  const el = $('vialSchedLine');
  el.className = 'sched-line';
  if (!name) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const p = protocolFor(protocols(), name);
  let text;
  if (p) text = `<span><b>${esc(name)}</b> schedule: ${esc(describeProtocol(p, fmtAmount))}</span>`;
  else if (isKnownMed(name)) text = `<span><b>${esc(name)}</b> is your main GLP-1 — it uses your shot day and dose plan.</span>`;
  else { el.className = 'sched-line warn'; text = `<span><b>${esc(name)}</b> is a new medication. Set up its schedule and injection sites first.</span>`; }
  el.innerHTML = `${text}<button type="button" class="act" data-edit-med-from-vial>${isKnownMed(name) ? 'Edit medication' : 'Set it up'}</button>`;
}
// Fill powder / water / price from the medication's vial defaults (only fields you haven't typed in).
function applyVialDefaults() {
  const ex = extrasFor($('sName').value);
  $('sUseWithin').placeholder = ex.useWithin ? `${ex.useWithin} (${$('sName').value.trim()} default)` : 'optional, e.g. 28';
  if (editingSupplyId) return;
  for (const [id, key] of [['sMg', 'vialMg'], ['sWater', 'waterMl'], ['sPrice', 'price']]) {
    const el = $(id);
    if (ex[key] != null && (el.value === '' || el.dataset.auto === '1')) { el.value = ex[key]; el.dataset.auto = '1'; }
    else if (el.dataset.auto === '1' && ex[key] == null) { el.value = ''; el.dataset.auto = ''; }
  }
}
for (const id of ['sMg', 'sWater', 'sPrice']) $(id).addEventListener('input', () => { $(id).dataset.auto = ''; });
$('sName').addEventListener('input', () => { updateNameHint(); applyVialDefaults(); updateSupplyCalc(); updateVialSchedLine(); });
$('vialSchedLine').addEventListener('click', ev => {
  if (ev.target.closest('[data-edit-med-from-vial]')) openMedEditor($('sName').value.trim(), { fromVial: true });
});

// "From inventory" pickers in the New vial screen.
const invItems = kind => (state.inventory || []).filter(x => x.kind === kind);
const waterLeft = w => (w.openMl || 0) + (w.qty || 0) * (w.bottleMl || 0);
function fillStockPick(fromInvId) {
  const peps = invItems('peptide').filter(x => x.qty > 0 || x.id === fromInvId);
  const waters = invItems('water').filter(x => waterLeft(x) > 0);
  $('stockPick').hidden = editingSupplyId != null || (!peps.length && !waters.length);
  $('sFromInv').innerHTML = '<option value="">— not from inventory —</option>'
    + peps.map(x => `<option value="${esc(x.id)}">${esc(x.name)}${x.mg ? ` ${trim(x.mg)} mg` : ''} (${esc(x.code)}) · ${x.qty} on hand</option>`).join('');
  $('sWaterFrom').innerHTML = '<option value="">— don’t track water —</option>'
    + waters.map(x => `<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.code)}) · ${trim(waterLeft(x))} mL left</option>`).join('');
  $('sFromInv').value = fromInvId || '';
  $('sWaterFrom').value = waters[0]?.id || '';
}
$('sFromInv').addEventListener('change', () => {
  const x = (state.inventory || []).find(i => i.id === $('sFromInv').value);
  if (!x) return;
  document.querySelector('input[name="sKind"][value="vial"]').checked = true;
  $('sName').value = x.name;
  if (x.mg) $('sMg').value = x.mg;
  if (x.price != null) $('sPrice').value = x.price;
  $('sName').dispatchEvent(new Event('input'));
  updateSupplyCalc();
});

// "What's actually left": show the computed amount and turn what you type into a correction.
function vialLeftNow(s) {
  // computed without any earlier correction
  return s ? usage({ ...s, adjustMg: 0 }, state.shots).leftMg : null;
}
function updateLeftFix() {
  const s = editingSupplyId ? supplyById(editingSupplyId) : null;
  const form = readSupplyForm();
  const conc = concentration(form);
  $('sLeftWrap').hidden = !s || form.kind !== 'vial' || !conc;
  if ($('sLeftWrap').hidden) return;
  const base = usage({ ...s, ...form, adjustMg: 0 }, state.shots).leftMg;
  const cur = usage({ ...s, ...form }, state.shots).leftMg;
  const show = mg => $('sLeftUnit').value === 'ml' ? `${trim(mg / conc)} mL` : `${trim(mgToUnits(mg, conc))} units`;
  $('sLeft').placeholder = show(cur).split(' ')[0];
  $('sLeftHelp').textContent = `By your logged shots: ${show(base)}${Math.abs(cur - base) > 1e-6 ? ` · corrected to ${show(cur)}` : ''}. Enter what you actually see if it's different.`;
}
$('sLeftUnit').addEventListener('change', updateLeftFix);
function readLeftFix(s, form) {
  const v = numOrNull('sLeft');
  const conc = concentration(form);
  if (v == null || !s || !conc) return undefined; // keep whatever correction there was
  const mg = $('sLeftUnit').value === 'ml' ? v * conc : unitsToMg(v, conc);
  return mg - usage({ ...s, ...form, adjustMg: 0 }, state.shots).leftMg;
}

function openSupplyDialog(s, presetName = null, opts = {}) {
  editingSupplyId = s ? s.id : null;
  $('supplyForm').reset();
  $('supplyTitle').textContent = s ? 'Edit vial' : 'New vial';
  $('supplyDelete').hidden = !s;
  $('supplyMsg').textContent = '';
  const inv = opts.fromInv ? (state.inventory || []).find(x => x.id === opts.fromInv) : null;
  const src = s || (inv
    ? { kind: 'vial', opened: Date.now(), name: inv.name, mg: inv.mg, price: inv.price, waterMl: opts.waterMl ?? null }
    : { kind: 'vial', opened: Date.now(), name: presetName ?? (mainList().at(-1)?.name || '') });
  document.querySelector(`input[name="sKind"][value="${src.kind}"]`).checked = true;
  $('sName').value = src.name || '';
  $('sOpened').value = localDateValue(src.opened);
  $('sMg').value = src.mg ?? '';
  $('sWater').value = src.waterMl ?? '';
  $('sCount').value = src.count ?? '';
  $('sPrice').value = src.price ?? '';
  $('sUseWithin').value = s ? s.useWithin ?? '' : '';
  $('sDone').checked = !!src.done;
  $('sNote').value = src.note || '';
  for (const id of ['sMg', 'sWater', 'sPrice']) $(id).dataset.auto = '';
  fillStockPick(inv?.id);
  applyVialDefaults();
  updateNameHint();
  updateSupplyCalc();
  updateVialSchedLine();
  $('sLeft').value = '';
  updateLeftFix();
  $('supplyDialog').showModal();
}

$('addSupplyBtn').addEventListener('click', () => openSupplyDialog(null));
$('supplyList').addEventListener('click', ev => {
  const b = ev.target.closest('[data-supply]');
  if (b) openSupplyDialog(supplyById(b.dataset.supply));
});
$('supplyForm').addEventListener('input', ev => { updateSupplyCalc(); if (ev.target.id !== 'sLeft') updateLeftFix(); });
$('supplyCancel').addEventListener('click', () => { mixForShot = false; $('supplyDialog').close(); });
$('supplyForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = readSupplyForm();
  if (!body.opened) { $('supplyMsg').textContent = 'Pick a date.'; return; }
  try {
    // A brand-new medication gets set up (schedule, sites) before its first vial.
    if (body.name && !isKnownMed(body.name)) {
      $('supplyMsg').textContent = `Set up ${body.name} first — its schedule and injection sites.`;
      openMedEditor(body.name, { fromVial: true });
      return;
    }
    let r;
    if (editingSupplyId) {
      const old = supplyById(editingSupplyId);
      const fix = readLeftFix(old, body);
      body.adjustMg = fix === undefined ? old.adjustMg ?? null : fix;
      r = await api('PUT', `/api/supplies/${encodeURIComponent(editingSupplyId)}`, body);
    }
    else r = await api('POST', '/api/supplies', { ...body, fromInventory: $('sFromInv').value || null, waterFrom: body.kind === 'vial' ? $('sWaterFrom').value || null : null });
    $('supplyDialog').close();
    await refresh();
    if (mixForShot && !editingSupplyId && r?.id) vialMixedForShot(r.id);
    if (r?.stockNotes?.length) alert(r.stockNotes.join('\n'));
  } catch (e) { $('supplyMsg').textContent = e.message; }
});
$('supplyDelete').addEventListener('click', async () => {
  if (!editingSupplyId || !confirm('Delete this vial? Shots taken from it are kept.')) return;
  await api('DELETE', `/api/supplies/${encodeURIComponent(editingSupplyId)}`);
  $('supplyDialog').close();
  await refresh();
});

// ---------- shot dialog ----------
const shotSupply = () => supplyById($('hSupply').value);

// ---- second vial for the rest of a dose ----
let editingParts = [];         // the stored shot(s) being edited
let doseTarget = null;         // the full dose (mg) this shot should add up to, when known
let part2Touched = false;      // you typed the second part yourself; stop auto-filling it
let mixForShot = false;        // a vial is being mixed from the shot screen to cover the rest
const splitOn = () => !$('splitBox').hidden;
const shotSupply2 = () => supplyById($('hSupply2').value);
const sameMed = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();
// Other open vials of the same medication as vial #1.
function otherVials() {
  const sup = shotSupply();
  if (!sup) return [];
  return state.supplies.filter(v => v.id !== sup.id && sameMed(v.name, sup.name) && (!v.done || editingParts.some(e => e.supplyId === v.id)));
}
function fillSplitVials(selectId) {
  const vs = otherVials();
  $('hSupply2').innerHTML = vs.map(v => `<option value="${esc(v.id)}">${esc(supplyLabel(v))}</option>`).join('');
  if (selectId && vs.some(v => v.id === selectId)) $('hSupply2').value = selectId;
  $('splitAdd').hidden = splitOn() || !vs.length;
}
function setSplit(on, mg2 = null, vialId = null) {
  $('splitBox').hidden = !on;
  if (on) {
    fillSplitVials(vialId);
    const conc2 = concentration(shotSupply2());
    $('hUnits2Wrap').hidden = !conc2;
    if (mg2 != null) { $('hMg2').value = trimMg(mg2); $('hUnits2').value = conc2 ? trim(mgToUnits(mg2, conc2)) : ''; }
  } else { $('hMg2').value = ''; $('hUnits2').value = ''; }
  $('splitAdd').hidden = on || !otherVials().length;
}
// What's left in a vial, ignoring the shot(s) being edited.
const leftIn = v => usage(v, state.shots.filter(x => !editingParts.some(e => e.id === x.id))).leftMg;
// If the chosen vial can't cover the whole dose, take the rest from the next vial of the same medication.
function autoSplit(totalMg) {
  const sup = shotSupply();
  if (!sup || sup.kind !== 'vial' || !(totalMg > 0)) return null;
  const left = leftIn(sup);
  if (left == null || left >= totalMg - 1e-6) return null;
  const next = otherVials().find(v => !v.done && (leftIn(v) ?? 0) > 0);
  if (!next) {
    // Nothing else mixed: use what's left here; the "short by" helper suggests stock to mix.
    if (left > 1e-6) {
      const c = concentration(sup);
      $('hMg').value = trimMg(left);
      if (c) $('hUnits').value = trim(mgToUnits(left, c));
    }
    return left > 1e-6 ? { short: totalMg - left } : null;
  }
  if (left <= 1e-6) {               // empty: just switch vials
    $('hSupply').value = next.id;
    return { switched: next };
  }
  // A tiny remainder isn't worth a second draw: just finish this vial.
  const conc = concentration(sup);
  if (totalMg - left < totalMg * 0.02) {
    $('hMg').value = trimMg(left);
    if (conc) $('hUnits').value = trim(mgToUnits(left, conc));
    return null;
  }
  $('hMg').value = trimMg(left);
  if (conc) $('hUnits').value = trim(mgToUnits(left, conc));
  setSplit(true, Math.round((totalMg - left) * 10000) / 10000, next.id);
  part2Touched = false;
  return { left, rest: totalMg - left, next };
}
// The rest of the dose still needed after part 1 (when the full dose is known).
const restNeeded = () => (doseTarget ? Math.max(0, Math.round((doseTarget - (numOrNull('hMg') || 0)) * 10000) / 10000) : null);
$('splitAdd').addEventListener('click', () => { part2Touched = false; setSplit(true, restNeeded()); updateShotForm('none'); });
$('splitRemove').addEventListener('click', () => { setSplit(false); updateShotForm('none'); });
$('hSupply2').addEventListener('change', () => {
  const conc2 = concentration(shotSupply2());
  $('hUnits2Wrap').hidden = !conc2;
  if (!part2Touched && restNeeded() != null) $('hMg2').value = trimMg(restNeeded());
  const mg2 = numOrNull('hMg2');
  $('hUnits2').value = conc2 && mg2 != null ? trim(mgToUnits(mg2, conc2)) : '';
  updateShotForm('none');
});
$('hUnits2').addEventListener('input', () => {
  part2Touched = true;
  const conc2 = concentration(shotSupply2()), u = numOrNull('hUnits2');
  if (conc2) $('hMg2').value = u != null ? trimMg(unitsToMg(u, conc2)) : '';
  updateShotForm('none');
});
$('hMg2').addEventListener('input', () => {
  part2Touched = true;
  const conc2 = concentration(shotSupply2()), mg = numOrNull('hMg2');
  if (conc2) $('hUnits2').value = mg != null ? trim(mgToUnits(mg, conc2)) : '';
  updateShotForm('none');
});
const splitNote = r => r && r.left != null
  ? `<span class="warn" style="color:var(--text-secondary)">Only ${esc(fmtMg(r.left))} left in this vial, so the rest (${esc(fmtMg(r.rest))}) comes from ${esc(supplyLabel(r.next))}.</span>`
  : r && r.switched ? `<span class="warn" style="color:var(--text-secondary)">That vial is empty, so this dose comes from ${esc(supplyLabel(r.switched))}.</span>`
  : r && r.short ? `<span class="warn" style="color:var(--text-secondary)">This vial only has part of the dose left — see below for where to get the rest.</span>` : '';

// Fill in the recommended dose for the chosen vial's medication (new shots only).
function applyRecommendation() {
  const hint = $('doseHint');
  hint.hidden = true;
  if (editingShotId) return;
  const sup = shotSupply();
  const name = sup ? sup.name : $('hName').value.trim();
  const p = protocolFor(protocols(), name);
  const conc = concentration(sup);
  if (p) {
    const rec = protocolDose(p, doses().filter(x => !editingParts.some(e => e.id === x.id)));
    // Same mg as the schedule, converted to units for *this* vial's strength.
    const targetMg = protoTargetMg(p, rec.amount, conc);
    if (targetMg != null) {
      $('hMg').value = trimMg(targetMg);
      if (conc) $('hUnits').value = trim(mgToUnits(targetMg, conc));
    }
    doseTarget = targetMg;
    const converted = p.unit === 'units' && concDiffers(conc, p.refConc)
      ? `<span class="warn" style="color:var(--text-primary)">Your schedule is ${esc(fmtAmount(rec.amount, 'units'))} on a ${trim(p.refConc)} mg/mL vial = ${esc(fmtMg(targetMg))}. This vial is ${trim(conc)} mg/mL, so draw <b>${trim(mgToUnits(targetMg, conc))} units</b> for the same dose.</span>`
      : '';
    const split = autoSplit(doseTarget);
    if (split?.switched) return applyRecommendation();
    const t = p.titrate || {};
    hint.hidden = false;
    hint.className = `full dose-hint${rec.stepUp ? ' up' : ''}`;
    hint.innerHTML = `${rec.stepUp ? '<b>Dose increase.</b> ' : ''}${esc(p.name)} schedule: <b>${esc(fmtAmount(rec.amount, p.unit))}</b>`
      + (t.enabled ? (rec.atMax ? ' — at your max dose.' : ` — dose ${(rec.taken % t.every) + 1} of ${t.every} before the next increase.`) : '.')
      + (p.unit === 'units' && !conc ? '<span class="warn">Pick a vial with powder mg and water so units can be converted.</span>' : '')
      + converted + splitNote(split);
    return;
  }
  if (planOn() && !protocolFor(protocols(), name)) {
    const rec = recommendDose(mainList().filter(x => !editingParts.some(e => e.id === x.id)), state.settings.plan, Date.now());
    $('hMg').value = trim(rec.doseMg);
    if (conc) $('hUnits').value = trim(mgToUnits(rec.doseMg, conc));
    doseTarget = rec.doseMg;
    const split = autoSplit(rec.doseMg);
    if (split?.switched) return applyRecommendation();
    hint.hidden = false;
    hint.className = `full dose-hint${rec.stepUp ? ' up' : ''}`;
    hint.innerHTML = `${rec.stepUp ? '<b>Dose increase.</b> ' : ''}Recommended: <b>${trim(rec.doseMg)} mg</b> — ${esc(rec.reason)}.${rec.warning ? `<span class="warn">${esc(rec.warning)}</span>` : ''}${splitNote(split)}`;
  }
}
// Site suggestion from the same medication track (main GLP-1, or this peptide).
function suggestSiteFor(name, excludeId) {
  const p = protocolFor(protocols(), name);
  const track = (p ? shotsOf(doses(), name) : mainList()).filter(x => x.id !== excludeId);
  const rotation = rotationFor(name);
  return { suggested: suggestSite(track, rotation), lastSite: [...track].reverse().find(x => x.site)?.site, rotation };
}
function renderSites(shot) {
  const sup = shotSupply();
  const name = sup ? sup.name : $('hName').value.trim();
  const { suggested, lastSite, rotation } = suggestSiteFor(name, shot?.id);
  const choices = [...allSites(), ...(shot?.site && !allSites().includes(shot.site) ? [shot.site] : [])].filter(x => rotation.includes(x) || x === shot?.site);
  $('siteGrid').innerHTML = choices.map(site => `<label><input type="radio" name="hSite" value="${esc(site)}"> ${esc(site)}${site === suggested ? '<span class="tag">suggested</span>' : site === lastSite ? '<span class="tag">last</span>' : ''}</label>`).join('');
  const pick = shot ? shot.site : suggested;
  const radio = [...document.querySelectorAll('input[name="hSite"]')].find(r => r.value === pick);
  if (radio) radio.checked = true;
  $('siteHint').textContent = lastSite ? `· last time: ${lastSite}` : '';
}

// "Short by X": where to get the rest of the dose — another mixed vial, or powder in inventory.
function makeUpHelp(sup, mg1) {
  if (!doseTarget || !sup) return '';
  const total = (mg1 || 0) + (splitOn() ? numOrNull('hMg2') || 0 : 0);
  const short = Math.round((doseTarget - total) * 10000) / 10000;
  if (short <= doseTarget * 0.02) return ''; // same "not worth a second draw" rule as autoSplit
  const opts = [];
  if (!splitOn()) {
    for (const v of otherVials().filter(v => !v.done)) {
      const left = leftIn(v) ?? 0, c = concentration(v);
      if (left < short - 1e-6) continue;
      opts.push(`<div class="makeup-opt"><span>From ${esc(supplyLabel(v))}: <b>${c ? `${trim(mgToUnits(short, c))} units` : esc(fmtMg(short))}</b></span><button type="button" class="act" data-makeup-vial="${esc(v.id)}">Use</button></div>`);
    }
  }
  if (!opts.length) {
    const water = sup.waterMl || 3;
    for (const x of invItems('peptide').filter(x => x.qty > 0 && sameMed(x.name, sup.name) && x.mg > 0)) {
      const units = mgToUnits(short, x.mg / water);
      opts.push(`<div class="makeup-opt"><span>Mix a new ${esc(x.name)} ${trim(x.mg)} mg vial (${esc(x.code)}, ${x.qty} in stock): with ${trim(water)} mL water, draw <b>${trim(units)} units</b></span><button type="button" class="act" data-makeup-mix="${esc(x.id)}" data-water="${water}">Mix it</button></div>`);
    }
  }
  return `<div class="makeup"><div class="line hl"><span>Short by</span><b>${esc(fmtMg(short))} of the ${esc(fmtMg(doseTarget))} dose</b></div>${opts.join('')
    || (splitOn() ? '' : `<div class="muted small">No other ${esc(sup.name)} vial or stock to make it up — add one in Inventory.</div>`)}</div>`;
}
$('shotCalc').addEventListener('click', ev => {
  const useVial = ev.target.closest('[data-makeup-vial]');
  const mix = ev.target.closest('[data-makeup-mix]');
  if (useVial) { part2Touched = false; setSplit(true, restNeeded(), useVial.dataset.makeupVial); updateShotForm('none'); }
  if (mix) {
    mixForShot = true;
    openSupplyDialog(null, null, { fromInv: mix.dataset.makeupMix, waterMl: Number(mix.dataset.water) });
  }
});
// Called after a vial is mixed from the shot screen: it becomes the second part.
function vialMixedForShot(vialId) {
  mixForShot = false;
  if (!$('shotDialog').open) return;
  part2Touched = false;
  setSplit(true, restNeeded(), vialId);
  updateShotForm('none');
}

function updateShotForm(changed) {
  const sup = shotSupply();
  const conc = concentration(sup);
  $('hNameWrap').hidden = !!sup;
  $('hUnitsWrap').hidden = !conc;
  // Units and mg stay in step for mixed vials.
  if (conc && changed === 'units') {
    const u = numOrNull('hUnits');
    $('hMg').value = u != null ? trimMg(unitsToMg(u, conc)) : '';
  } else if (conc && (changed === 'mg' || changed === 'supply')) {
    const mg = numOrNull('hMg');
    $('hUnits').value = mg != null ? trim(mgToUnits(mg, conc)) : '';
  }
  // Typing the amount drawn from vial 1 updates vial 2 to the rest of the dose.
  if (splitOn() && !part2Touched && doseTarget && (changed === 'units' || changed === 'mg')) {
    const rest = restNeeded(), conc2 = concentration(shotSupply2());
    $('hMg2').value = trimMg(rest);
    $('hUnits2').value = conc2 ? trim(mgToUnits(rest, conc2)) : '';
  }
  const mg = numOrNull('hMg');
  const out = [];
  if (sup) {
    // What's left after this shot (excluding the shot being edited).
    const others = state.shots.filter(x => !editingParts.some(e => e.id === x.id));
    const draft = mg ? [{ supplyId: sup.id, doseMg: mg, t: Date.now() }] : [];
    const u = usage(sup, [...others, ...draft]);
    if (sup.kind === 'vial' && u.leftMg != null) {
      out.push(`<div class="line hl"><span>Left after this shot</span><b>${conc ? `${trim(u.leftMl)} mL (${trim(u.leftUnits)} units)` : `${trim(u.leftMg)} mg`}</b></div>`);
      if (u.shotsLeft != null) out.push(`<div class="line"><span>More shots at this dose</span><b>${u.shotsLeft}</b></div>`);
      if (mg && u.leftMg === 0 && usage(sup, others).leftMg < mg - 1e-9) out.push(`<div class="msg">That's more than what's left in this vial.</div>`);
    } else if (sup.kind === 'pack' && u.left != null) {
      out.push(`<div class="line hl"><span>Left after this shot</span><b>${u.left} of ${sup.count}</b></div>`);
    }
    const c = mg ? shotCost({ doseMg: mg }, sup) : null;
    if (c != null) out.push(`<div class="line"><span>Cost of this shot</span><b>${money(c)}</b></div>`);
  }
  if (splitOn()) {
    const sup2 = shotSupply2(), mg2 = numOrNull('hMg2');
    if (sup2 && mg2) {
      const u2 = usage(sup2, [...state.shots.filter(x => !editingParts.some(e => e.id === x.id)), { supplyId: sup2.id, doseMg: mg2, t: Date.now() }]);
      if (u2.leftMl != null) out.push(`<div class="line"><span>Left in second vial</span><b>${trim(u2.leftMl)} mL (${trim(u2.leftUnits)} units)</b></div>`);
    }
    out.push(`<div class="line hl"><span>Total dose</span><b>${fmtMg((mg || 0) + (mg2 || 0))}${numOrNull('hUnits') != null && numOrNull('hUnits2') != null ? ` · ${trim(numOrNull('hUnits') + numOrNull('hUnits2'))} units in the syringe` : ''}</b></div>`);
  }
  out.push(makeUpHelp(sup, mg));
  $('shotCalc').innerHTML = out.join('') || `<span class="muted">${sup ? 'Enter the dose.' : 'Not tracked against a vial.'}</span>`;
}

function openShotDialog(dose, opts = {}) {
  // `dose` may be a combined dose with .parts (split across two vials).
  editingParts = dose ? (dose.parts || [dose]) : [];
  const shot = editingParts[0] || null;
  editingShotId = shot ? shot.id : null;
  doseTarget = editingParts.length > 1 ? editingParts.reduce((n, x) => n + (x.doseMg || 0), 0) : null;
  part2Touched = editingParts.length > 1;
  $('splitBox').hidden = true;
  $('shotForm').reset();
  $('shotTitle').textContent = shot ? 'Edit shot' : 'Log shot';
  $('shotDelete').hidden = !shot;
  $('shotMsg').textContent = '';
  const open = state.supplies.filter(s => !s.done || s.id === shot?.supplyId);
  $('hSupply').innerHTML = open.slice().reverse().map(s => `<option value="${esc(s.id)}">${esc(supplyLabel(s))}</option>`).join('')
    + `<option value="">Other / not tracked</option>`;
  // New shot: a specific medication (from its banner), else continue the main GLP-1.
  const last = opts.med ? shotsOf(doses(), opts.med).at(-1) : mainList().at(-1);
  const medVial = opts.med ? vialToUse(opts.med) : null;
  const src = shot || {
    t: Date.now(),
    supplyId: medVial ? medVial.id : opts.med ? '' : (open.some(s => s.id === last?.supplyId) ? last.supplyId : (open.find(s => !protocolFor(protocols(), s.name))?.id ?? '')),
    name: opts.med || last?.name || '', doseMg: last?.doseMg ?? '', note: '',
  };
  $('hWhen').value = localInputValue(src.t);
  $('hSupply').value = src.supplyId || '';
  $('hName').value = src.name || '';
  $('hMg').value = src.doseMg ?? '';
  $('hNote').value = src.note || '';
  renderSites(shot);
  updateShotForm('supply');
  setSplit(false);
  if (editingParts[1]) {
    setSplit(true, editingParts[1].doseMg, editingParts[1].supplyId);
    if (editingParts[1].units != null) $('hUnits2').value = trim(editingParts[1].units);
  }
  applyRecommendation();
  updateShotForm('none');
  if (shot?.units != null) $('hUnits').value = trim(shot.units);
  if (!opts.quiet) $('shotDialog').showModal();
}

$('addShotBtn').addEventListener('click', () => openShotDialog(null));
$('shotList').addEventListener('click', ev => {
  if (ev.target.id === 'moreShots') { showAllShots = !showAllShots; renderShots(); return; }
  const b = ev.target.closest('[data-shot]');
  if (b) openShotDialog(doses().find(x => x.id === b.dataset.shot));
});
$('hUnits').addEventListener('input', () => updateShotForm('units'));
$('hMg').addEventListener('input', () => updateShotForm('mg'));
$('hSupply').addEventListener('change', () => { setSplit(false); updateShotForm('supply'); applyRecommendation(); updateShotForm('none'); renderSites(null); });
$('hName').addEventListener('change', () => { applyRecommendation(); updateShotForm('none'); renderSites(null); });
$('shotCancel').addEventListener('click', () => $('shotDialog').close());
$('shotForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (await saveShot()) { $('shotDialog').close(); await refresh(); }
});
// Saves what's in the shot form. Returns the ids of new shots (for Undo), or null if something's missing.
async function saveShot() {
  const sup = shotSupply();
  const t = new Date($('hWhen').value).getTime();
  const body = {
    t,
    supplyId: sup?.id ?? null,
    name: sup ? sup.name : $('hName').value.trim(),
    doseMg: numOrNull('hMg'),
    units: concentration(sup) ? numOrNull('hUnits') : null,
    site: document.querySelector('input[name="hSite"]:checked')?.value ?? null,
    note: $('hNote').value.trim(),
  };
  if (!Number.isFinite(t)) { $('shotMsg').textContent = 'Pick a date and time.'; return null; }
  if (!body.name) { $('shotMsg').textContent = 'Enter the medication name.'; return null; }
  const sup2 = splitOn() ? shotSupply2() : null;
  if (splitOn() && (!sup2 || !(numOrNull('hMg2') > 0))) { $('shotMsg').textContent = 'Enter the dose from the second vial, or remove it.'; return null; }
  // (crypto.randomUUID only exists over HTTPS; this works on the plain-HTTP LAN address too)
  const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
  const groupId = sup2 ? (editingParts.find(x => x.groupId)?.groupId || newId()) : null;
  const part2 = sup2 ? { ...body, supplyId: sup2.id, name: sup2.name, doseMg: numOrNull('hMg2'), units: concentration(sup2) ? numOrNull('hUnits2') : null, groupId } : null;
  try {
    const created = [];
    const [old1, old2] = editingParts;
    const p1 = { ...body, groupId };
    if (old1) await api('PUT', `/api/shots/${encodeURIComponent(old1.id)}`, p1); else created.push((await api('POST', '/api/shots', p1)).id);
    if (part2) {
      if (old2) await api('PUT', `/api/shots/${encodeURIComponent(old2.id)}`, part2); else created.push((await api('POST', '/api/shots', part2)).id);
    } else if (old2) {
      await api('DELETE', `/api/shots/${encodeURIComponent(old2.id)}`);
    }
    return created;
  } catch (e) { $('shotMsg').textContent = e.message; return null; }
}

// One tap from Next shots: log the planned dose now, from the vial in use, at the suggested site.
// Anything that needs a decision (split across vials, not enough left, no dose) opens the dialog instead.
async function quickLog(med) {
  openShotDialog(null, { ...(med && { med }), quiet: true });
  const sup = shotSupply(), mg = numOrNull('hMg');
  const short = sup?.kind === 'vial' && (usage(sup, state.shots).leftMg ?? Infinity) < mg * 0.98;
  if (splitOn() || !(mg > 0) || short) { $('shotDialog').showModal(); return; }
  const ids = await saveShot();
  if (!ids) { $('shotDialog').showModal(); return; }
  await refresh();
  const site = document.querySelector('input[name="hSite"]:checked')?.value;
  toast(`Logged ${$('hName').value || sup?.name || ''} ${fmtMg(mg)}${site ? ` · ${site}` : ''}`, async () => {
    for (const id of ids) await api('DELETE', `/api/shots/${encodeURIComponent(id)}`);
    await refresh();
  });
}
let toastTimer;
function toast(text, undo) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
  const b = el.querySelector('button');
  if (b) b.onclick = async () => { el.hidden = true; clearTimeout(toastTimer); try { await undo(); } catch (e) { alert(e.message); } };
}
$('shotDelete').addEventListener('click', async () => {
  if (!editingParts.length || !confirm(editingParts.length > 1 ? 'Delete this dose (both vial parts)?' : 'Delete this shot?')) return;
  for (const x of editingParts) await api('DELETE', `/api/shots/${encodeURIComponent(x.id)}`);
  $('shotDialog').close();
  await refresh();
});

// ---------- goal, units, export ----------
$('goalForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('goalMsg').textContent = ''; $('goalMsg').className = 'msg';
  const g = $('goal').value.trim(), d = $('goalDate').value;
  try {
    await api('PUT', '/api/settings', { goal: g === '' ? null : fromDisp(parseFloat(g)), goalDate: d ? dateInputToMs(d) : null });
    document.activeElement.blur();
    await refresh();
    $('goalMsg').className = 'msg ok'; $('goalMsg').textContent = 'Saved.';
    setTimeout(() => { $('goalMsg').textContent = ''; }, 2000);
  } catch (e) { $('goalMsg').textContent = e.message; }
});

$('unit').addEventListener('change', async ev => {
  await api('PUT', '/api/settings', { unit: ev.target.value });
  await refresh();
});

$('exportBtn').addEventListener('click', () => {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [`date,weight_${unit()},note,dose`, ...state.entries.map(e => {
    const med = shotAt(mainList(), e.t);
    return [new Date(e.t).toISOString(), fmtNum(e.weight), q(e.note), q(med ? shotLabel(med) : '')].join(',');
  })];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'weight-log.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => $('appView').hidden || render(), 100); });

// ---------- banners (shot day, refills) ----------

function lastShotLine(last) {
  if (!last) return '';
  return `Last shot ${fmtDay(last.t)} · ${esc(shotLabel(last))}${last.units != null ? ` (${trim(last.units)} units)` : ''}${last.site ? ` · ${esc(last.site)}` : ''}`;
}

function useByText(ub) {
  if (ub.daysLeft < 0) return `Past its use-by date (${fmtDay(ub.by)})`;
  const when = ub.daysLeft === 0 ? 'today' : ub.daysLeft === 1 ? 'tomorrow' : `in ${ub.daysLeft} days (${fmtDay(ub.by)})`;
  return `Use by ${when}${ub.wontFinish ? ` · about ${ub.shotsLeft} dose${ub.shotsLeft === 1 ? '' : 's'} left, more than you’ll use by then` : ''}`;
}
function renderBanners() {
  const { shots, supplies, settings } = state;
  const out = [];
  if (settings.showShots === false || settings.banners?.enabled === false) { $('banners').innerHTML = ''; return; }
  const bannerOff = key => (settings.banners?.off || []).includes(key);
  const main = mainList();
  if (main.length && !bannerOff('main')) {
    const st = shotStatus(main, settings.shotDay, Date.now());
    const last = main[main.length - 1];
    let next = `Suggested site: <b>${esc(suggestSiteFor(last.name).suggested)}</b>`;
    if (planOn()) {
      const rec = recommendDose(main, settings.plan, Date.now());
      const conc = currentConc();
      const dose = `${trim(rec.doseMg)} mg${conc ? ` (${trim(mgToUnits(rec.doseMg, conc))} units)` : ''}`;
      next = (rec.stepUp ? `<span class="stepup">Dose increase today: ${dose}</span> — up from ${trim(rec.from)} mg` : `Dose: <b>${dose}</b>`) + ` · ${next}`;
    }
    if (st.state === 'due-today') {
      out.push(`<div class="banner shot"><div class="title">SHOT DAY</div>
        <div class="body">${lastShotLine(last)}</div><div class="body">${next}</div>
        <button type="button" data-action="log-shot">Log shot</button></div>`);
    } else if (st.state === 'overdue') {
      out.push(`<div class="banner overdue"><div class="title">Shot overdue — was due ${fmtDay(st.due)}</div>
        <div class="body">${lastShotLine(last)}</div><div class="body">${next}</div>
        <button type="button" class="primary" data-action="log-shot">Log shot</button></div>`);
    }
  }
  // Other medications due today.
  for (const p of protocols()) {
    if (bannerOff(lc(p.name))) continue;
    const st = protocolStatus(p, doses(), Date.now());
    if (!['due-today', 'overdue', 'done-today'].includes(st.state) || (st.state === 'done-today' && p.freq === 'asneeded')) continue;
    const { rec, txt } = protoDoseText(p);
    const site = suggestSiteFor(p.name).suggested;
    if (st.state === 'done-today') continue; // logged today: nothing to remind you of (Next shots shows ✓)
    const vial = vialToUse(p.name);
    out.push(`<div class="banner med${st.state === 'overdue' ? ' overdue' : ''}">
        <div class="title">${esc(p.name)} ${st.state === 'overdue' ? `overdue — was due ${fmtDay(st.due)}` : 'today'}</div>
        <div class="body">${rec.stepUp ? '<span class="stepup">Dose increase:</span> ' : 'Dose: '}<b>${esc(txt)}</b> · Suggested site: <b>${esc(site)}</b></div>
        <div class="body">${vial ? `From ${esc(supplyLabel(vial))}` : 'No open vial — add one to track what’s left'}</div>
        <button type="button" data-action="log-med" data-name="${esc(p.name)}">Log</button></div>`);
  }
  // Mixed vials / cartridges near their use-by date (a week out, or sooner if it won't be finished in time).
  for (const v of supplies.filter(v => !v.done && v.kind === 'vial')) {
    const ub = useBy(state, v);
    if (!ub || bannerOff(protocolFor(protocols(), v.name) ? lc(v.name) : 'main')) continue;
    if (ub.daysLeft > 7 && !(ub.wontFinish && ub.daysLeft <= 14)) continue;
    if (ub.shotsLeft === 0) continue; // empty: the refill banner covers it
    const mixed = Math.round((DAY0(Date.now()) - DAY0(v.opened)) / DAY);
    out.push(`<div class="banner refill${ub.daysLeft <= 0 ? ' overdue' : ''}"><div class="title">${esc(supplyLabel(v))}: ${ub.daysLeft < 0 ? 'past use-by' : ub.daysLeft === 0 ? 'use by today' : `${ub.daysLeft} day${ub.daysLeft === 1 ? '' : 's'} left`}</div>
      <div class="body">Mixed ${mixed} day${mixed === 1 ? '' : 's'} ago · ${esc(useByText(ub))}</div>
      <button type="button" data-action="edit-supply" data-id="${esc(v.id)}">Vial</button></div>`);
  }
  // Time to reorder.
  for (const r of settings.reorderOn === false ? [] : reorderPlan(state, Date.now(), settings.reorderLead ?? 10)) {
    if (!r.orderSoon || bannerOff(r.key)) continue;
    out.push(`<div class="banner refill"><div class="title">Order ${esc(r.name)} ${r.orderBy < DAY0(Date.now()) ? 'now' : `by ${fmtDay(r.orderBy)}`}</div>
      <div class="body">${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} of ${esc(r.name)} left at ${esc(fmtMg(r.doseMg))} per dose — runs out around ${fmtDay(r.runOut)}.</div>
      <button type="button" data-action="inventory">Plan</button></div>`);
  }
  for (const x of invAlerts()) {
    out.push(`<div class="banner refill"><div class="title">${esc(x.title)}</div><div class="body">${esc(x.body)}</div>
      <button type="button" data-action="inventory">Inventory</button></div>`);
  }
  for (const { supply, left } of refillAlerts(supplies, shots, settings.refillAt ?? 3)) {
    const what = esc(supplyLabel(supply));
    out.push(left === 0
      ? `<div class="banner refill"><div class="title">Empty: ${what}</div>
          <div class="body">Not enough left for another shot. ${takenText(supply)} from it. Mark it finished and add your next vial.</div>
          <button type="button" data-action="edit-supply" data-id="${esc(supply.id)}">Update</button></div>`
      : `<div class="banner refill"><div class="title">Refill soon: ${left} dose${left === 1 ? '' : 's'} left</div>
          <div class="body">${what} · ${takenText(supply)}</div></div>`);
  }
  $('banners').innerHTML = out.join('');
}
$('banners').addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]');
  if (!b) return;
  if (b.dataset.action === 'log-shot') openShotDialog(null);
  if (b.dataset.action === 'log-med') openShotDialog(null, { med: b.dataset.name });
  if (b.dataset.action === 'inventory') location.hash = '#inventory';
  if (b.dataset.action === 'edit-supply') openSupplyDialog(supplyById(b.dataset.id));
});

// ---------- progress & milestones ----------
function renderDoseResults() {
  const on = state.settings.doseChart === true && state.settings.showShots !== false;
  const rows = on ? doseResults(state) : [];
  $('doseCard').hidden = !rows.length;
  if (!rows.length) return;
  const max = Math.max(0.5, ...rows.map(r => Math.abs(r.lbPerWeek ?? 0)));
  $('doseResults').innerHTML = rows.map(r => {
    const v = r.lbPerWeek;
    const pct = v == null ? 0 : Math.min(100, Math.abs(v) / max * 100);
    const label = v == null ? 'not enough weigh-ins' : `${v <= 0 ? '−' : '+'}${Math.abs(toDisp(v)).toFixed(1)} ${unit()}/week`;
    const weeks = Math.max(1, Math.round(r.weeks));
    return `<div class="dose-row${r.current ? ' current' : ''}">
      <div class="dlabel"><b>${esc(fmtMg(r.doseMg))}</b> <span class="muted small">${esc(r.name)}</span></div>
      <div class="dbar"><span class="${v > 0 ? 'gain' : ''}" style="width:${pct}%"></span></div>
      <div class="dval">${label}</div>
      <div class="dsub muted small">${fmtShort(r.start)} · ${weeks} wk · ${r.shots} shot${r.shots === 1 ? '' : 's'}${r.current ? ' · current' : ''}</div>
    </div>`;
  }).join('');
}
function renderProgress() {
  const p = progress(state.entries, state.settings.heightIn);
  $('progressCard').hidden = !p || state.entries.length < 2;
  if (!p) return;
  const miles = p.milestones.map(m => {
    if (m.date) return `<span class="mile hit">${m.pct}% ✓ ${fmtShort(m.date)}</span>`;
    if (m === p.next) return `<span class="mile next">${m.pct}% at ${fmtW(m.target)} · ${Math.abs(toDisp(p.current.weight - m.target)).toFixed(1)} to go</span>`;
    return '';
  }).join('');
  let bmiLine = `<a href="#" class="linkish" data-action="settings">Add your height in Settings to see BMI</a>`;
  if (p.bmi != null) bmiLine = `BMI <b>${p.bmi.toFixed(1)}</b> (${p.bmiCategory}) · started at ${p.startBmi.toFixed(1)}`;
  $('progress').innerHTML = `
    <div class="prog-head"><span class="big">${signed(-p.lost)} ${unit()}</span><span class="pct">${p.pctLost.toFixed(1)}% of body weight</span></div>
    <div class="prog-sub">From ${fmtW(p.start.weight)} on ${fmtShort(p.start.t)} · lowest ${fmtW(p.lowest.weight)} on ${fmtShort(p.lowest.t)}</div>
    <div class="miles">${miles}</div>
    <div class="bmi">${bmiLine}</div>`;
}
$('progress').addEventListener('click', ev => {
  if (ev.target.closest('[data-action="settings"]')) { ev.preventDefault(); openSettings(); }
});

// ---------- settings ----------
function openSettings() {
  document.querySelector('.menu').open = false;
  const st = state.settings;
  $('setRefill').value = st.refillAt ?? 3;
  $('setFt').value = st.heightIn ? Math.floor(st.heightIn / 12) : '';
  $('setIn').value = st.heightIn ? trim(st.heightIn % 12) : '';
  $('setShowShots').checked = st.showShots !== false;
  $('setTrackWeight').checked = st.trackWeight !== false;
  $('setBanners').checked = st.banners?.enabled !== false;
  const off = st.banners?.off || [];
  const mains = mainNames();
  const bannerMeds = [...(mains.length ? [['main', `${mains.join(' / ')} (shot day)`]] : []), ...protocols().map(p => [lc(p.name), p.name])];
  $('setBannerMeds').innerHTML = bannerMeds.map(([k, label]) => `<label class="check"><input type="checkbox" name="bannerMed" value="${esc(k)}"${off.includes(k) ? '' : ' checked'}> ${esc(label)}</label>`).join('');
  $('setBannerMeds').hidden = !$('setBanners').checked;
  renderLayoutList(layoutOrder(st.layout));
  // Reminders
  const n = st.notify || {};
  $('setNotify').checked = !!n.enabled;
  $('setNotifyTime').value = n.time || '08:00';
  $('setNotifyMeds').innerHTML = bannerMeds.map(([k, label]) => `<label class="check"><input type="checkbox" name="notifyMed" value="${esc(k)}"${(n.off || []).includes(k) ? '' : ' checked'}> ${esc(label)}</label>`).join('');
  $('notifyBody').hidden = !n.enabled;
  updatePushStatus();
  // Extras
  $('setDoseChart').checked = st.doseChart === true;
  $('setPhotos').checked = st.photos === true;
  $('setWeekly').checked = !!st.weeklyEmail?.enabled;
  $('setWeeklyDay').innerHTML = WEEKDAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
  $('setWeeklyDay').value = String(st.weeklyEmail?.day ?? 0);
  $('setWeeklyTime').value = st.weeklyEmail?.time || '18:00';
  $('setExport').checked = !!st.monthlyExport?.enabled;
  $('setLead').value = st.reorderLead ?? 10;
  $('setReorder').checked = st.reorderOn !== false;
  $('reorderBody').hidden = !$('setReorder').checked;
  updateExtras();
  $('shotSettings').hidden = !$('setShowShots').checked;
  $('settingsMsg').textContent = ''; $('settingsMsg').className = 'msg';
  $('settingsDialog').showModal();
}
$('settingsBtn').addEventListener('click', openSettings);
function updateExtras() {
  $('weeklyBody').hidden = !$('setWeekly').checked;
  $('exportBody').hidden = !$('setExport').checked;
  const needs = [];
  if (!state.me?.email) needs.push('add your email in ⋯ → My account');
  if (!state.mailReady) needs.push(role === 'admin' ? 'set up email on the Admin page' : 'ask the admin to set up email');
  $('extrasHelp').textContent = ($('setWeekly').checked || $('setExport').checked) && needs.length ? `For emails: ${needs.join(' and ')}.` : '';
}
for (const id of ['setWeekly', 'setExport']) $(id).addEventListener('change', updateExtras);
$('setReorder').addEventListener('change', () => { $('reorderBody').hidden = !$('setReorder').checked; });
$('setNotify').addEventListener('change', () => { $('notifyBody').hidden = !$('setNotify').checked; });
for (const [btn, url, okText] of [['weeklySend', '/api/summary/send', 'Summary sent — check your email.'], ['exportSend', '/api/export/send', 'Export sent — check your email.']]) {
  $(btn).addEventListener('click', async () => {
    $(btn).disabled = true;
    try { await api('POST', url, {}); $('settingsMsg').className = 'msg ok'; $('settingsMsg').textContent = okText; }
    catch (e) { $('settingsMsg').className = 'msg'; $('settingsMsg').textContent = e.message; }
    finally { $(btn).disabled = false; }
  });
}

// ---------- push notifications (this device) ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function updatePushStatus() {
  const el = $('pushStatus');
  if (!pushSupported()) {
    $('pushEnable').hidden = true; $('pushTest').hidden = true;
    el.textContent = !window.isSecureContext
      ? 'Notifications need the https:// address of this app.'
      : isIos() ? 'On iPhone: tap Share → Add to Home Screen, open the app from there, then come back here.' : 'This browser doesn’t support notifications.';
    return;
  }
  const sub = await currentSub().catch(() => null);
  const { devices } = await api('GET', '/api/push/key').catch(() => ({ devices: 0 }));
  $('pushEnable').hidden = false;
  $('pushEnable').textContent = sub ? 'Turn off for this device' : 'Turn on for this device';
  $('pushTest').hidden = !devices;
  el.textContent = Notification.permission === 'denied'
    ? 'Notifications are blocked for this app — allow them in your phone’s settings.'
    : `${sub ? 'On for this device.' : 'Not on for this device yet.'}${devices ? ` ${devices} device${devices === 1 ? '' : 's'} signed up.` : ''}`;
}
function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
$('pushEnable').addEventListener('click', async () => {
  const msg = t => { $('pushStatus').textContent = t; };
  try {
    const old = await currentSub();
    if (old) {
      await api('POST', '/api/push/unsubscribe', { endpoint: old.endpoint });
      await old.unsubscribe();
    } else {
      if (await Notification.requestPermission() !== 'granted') { msg('Permission wasn’t given, so notifications stay off.'); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await api('GET', '/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      if (!$('setNotify').checked) { $('setNotify').checked = true; $('notifyBody').hidden = false; }
    }
    await updatePushStatus();
  } catch (e) { msg(`Couldn’t turn on notifications: ${e.message}`); }
});
$('pushTest').addEventListener('click', async () => {
  try {
    const { sent } = await api('POST', '/api/push/test', {});
    $('pushStatus').textContent = sent ? `Test sent to ${sent} device${sent === 1 ? '' : 's'}.` : 'No devices got it — turn it on again for this device.';
  } catch (e) { $('pushStatus').textContent = e.message; }
});
$('setBanners').addEventListener('change', () => { $('setBannerMeds').hidden = !$('setBanners').checked; });
// Rearrange sections: drag the ☰ handle (mouse or touch), or use the arrows.
function renderLayoutList(order) {
  const label = Object.fromEntries(SECTIONS.map(x => [x[0], x]));
  const weightOff = !$('setTrackWeight').checked;
  $('setLayout').innerHTML = order.map(id => `<li data-id="${id}" class="${label[id][2] && weightOff ? 'off' : ''}">
    <span class="grip" aria-hidden="true">☰</span><span class="lname">${esc(label[id][1])}${label[id][2] && weightOff ? ' (weight off)' : ''}</span>
    <button type="button" data-move="-1" aria-label="Move up">▲</button><button type="button" data-move="1" aria-label="Move down">▼</button></li>`).join('');
}
$('setTrackWeight').addEventListener('change', () => renderLayoutList([...$('setLayout').children].map(li => li.dataset.id)));
$('setLayout').addEventListener('click', ev => {
  const b = ev.target.closest('[data-move]');
  if (!b) return;
  const li = b.closest('li');
  if (b.dataset.move === '-1' && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
  if (b.dataset.move === '1' && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
});
let dragLi = null;
$('setLayout').addEventListener('pointerdown', ev => {
  if (!ev.target.closest('.grip')) return;
  dragLi = ev.target.closest('li');
  dragLi.classList.add('dragging');
  dragLi.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
$('setLayout').addEventListener('pointermove', ev => {
  if (!dragLi) return;
  const over = [...$('setLayout').children].find(li => li !== dragLi && ev.clientY > li.getBoundingClientRect().top && ev.clientY < li.getBoundingClientRect().bottom);
  if (!over) return;
  const r = over.getBoundingClientRect();
  over.parentNode.insertBefore(dragLi, ev.clientY < r.top + r.height / 2 ? over : over.nextElementSibling);
});
const endDrag = () => { if (dragLi) { dragLi.classList.remove('dragging'); dragLi = null; } };
$('setLayout').addEventListener('pointerup', endDrag);
$('setLayout').addEventListener('pointercancel', endDrag);
$('setMedsLink').addEventListener('click', () => { $('settingsDialog').close(); location.hash = '#meds'; });
$('planOn').addEventListener('change', () => { $('planBody').hidden = !$('planOn').checked; });
$('setShowShots').addEventListener('change', () => { $('shotSettings').hidden = !$('setShowShots').checked; });
$('settingsCancel').addEventListener('click', () => $('settingsDialog').close());
$('settingsForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const ft = numOrNull('setFt'), inch = numOrNull('setIn');
  const heightIn = ft == null && inch == null ? null : (ft || 0) * 12 + (inch || 0);
  try {
    await api('PUT', '/api/settings', {
      refillAt: Number($('setRefill').value),
      heightIn,
      showShots: $('setShowShots').checked,
      trackWeight: $('setTrackWeight').checked,
      banners: { enabled: $('setBanners').checked, off: [...document.querySelectorAll('input[name="bannerMed"]:not(:checked)')].map(x => x.value) },
      layout: [...$('setLayout').children].map(li => li.dataset.id),
      notify: { enabled: $('setNotify').checked, time: $('setNotifyTime').value || '08:00', off: [...document.querySelectorAll('input[name="notifyMed"]:not(:checked)')].map(x => x.value) },
      doseChart: $('setDoseChart').checked,
      photos: $('setPhotos').checked,
      weeklyEmail: { enabled: $('setWeekly').checked, day: Number($('setWeeklyDay').value), time: $('setWeeklyTime').value || '18:00' },
      monthlyExport: { enabled: $('setExport').checked },
      reorderOn: $('setReorder').checked,
      reorderLead: Math.round(Number($('setLead').value) || 0),
    });
    $('settingsDialog').close();
    await refresh();
  } catch (e) { $('settingsMsg').textContent = e.message; }
});

// ---------- users (admin only) ----------
function randomPassword() {
  // Easy to read out loud: no 0/O or 1/l/I.
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map(b => chars[b % chars.length]).join('');
}
let usersCache = [];
const fullName = u => [u.firstName, u.lastName].filter(Boolean).join(' ');
async function renderUsers() {
  const [users, invites] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/invites')]);
  usersCache = users;
  $('userList').innerHTML = users.map(u => `<div class="user-row">
      <div class="name">${esc(fullName(u) || u.user)}${u.role === 'admin' ? '<span class="badge admin">Admin</span>' : ''}${u.mustChange ? '<span class="badge pending">Hasn’t picked a password yet</span>' : ''}</div>
      <div class="meta"><span class="handle">@${esc(u.user)}</span>${u.email ? ` · <span class="email">${esc(u.email)}</span>` : ' · <span class="muted">no email</span>'} · added ${fmtShort(u.created || Date.now())}</div>
      <div class="btns">
        <button type="button" class="act" data-edit="${esc(u.id)}">Edit</button>
        ${u.user === user ? '' : `
        <button type="button" class="act" data-reset="${esc(u.id)}">Reset password</button>
        <button type="button" class="act del" data-remove="${esc(u.id)}">Remove</button>`}
      </div>
    </div>`).join('');
  $('inviteList').innerHTML = invites.length
    ? `<h3 class="sub-h">Invites waiting</h3>` + invites.map(i => `<div class="invite-row">
        <div class="name">${esc(i.name || i.email || 'Invite link')}${i.name && i.email ? ` <span class="muted small">${esc(i.email)}</span>` : ''}</div>
        <div class="meta">Invited ${fmtShort(i.created)} · link expires ${fmtShort(i.exp)}</div>
        <div class="btns">
          <button type="button" class="act" data-resend="${esc(i.id)}" data-who="${esc(i.name || i.email || '')}">${i.email && state.mailReady ? 'Resend' : 'New link'}</button>
          <button type="button" class="act del" data-cancel="${esc(i.id)}" data-email="${esc(i.name || i.email || 'this person')}">Cancel</button>
        </div>
      </div>`).join('')
    : '';
}
function usersMsg(html, ok) { $('usersMsg').className = `msg${ok ? ' ok' : ''}`; $('usersMsg').innerHTML = html; }
// After adding/resetting: say whether the email went out, and show the password if it didn't.
// A ready-to-send message with Copy and Share (Share opens Messages etc. on a phone).
function shareBox(intro, message) {
  return `<div class="new-pass">${intro}<div class="share-box">
    <textarea readonly aria-label="Message to send">${esc(message)}</textarea>
    <div class="row-btns"><button type="button" class="primary" data-copy-msg>Copy</button>${navigator.share ? '<button type="button" data-share-msg>Share…</button>' : ''}</div>
  </div></div>`;
}
$('usersMsg').addEventListener('click', async ev => {
  const box = ev.target.closest('.share-box');
  if (!box) return;
  const text = box.querySelector('textarea').value;
  if (ev.target.closest('[data-copy-msg]')) {
    const b = ev.target.closest('[data-copy-msg]');
    try { await navigator.clipboard.writeText(text); }
    catch { const t = box.querySelector('textarea'); t.focus(); t.select(); document.execCommand('copy'); }
    b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy'; }, 2000);
  }
  if (ev.target.closest('[data-share-msg]')) navigator.share({ text }).catch(() => {});
});
function showSent(name, pass, r, firstName = '') {
  const hi = firstName ? `Hi ${firstName}! ` : 'Hi! ';
  const msg = `${hi}I set you up on PeptideTracker.\n\nSign in here: ${r.loginLink || location.origin}\nUsername: ${name}\nTemporary password: ${pass}\n\nYou’ll pick your own password the first time you sign in.`;
  usersMsg((r.emailed ? `<div class="new-pass">Emailed <b>${esc(name)}</b> their login at <b>${esc(r.email)}</b>.</div>` : '')
    + shareBox(r.emailed ? 'Or text them this:' : `Send <b>${esc(name)}</b> their login:`, msg)
    + (r.emailError ? `<div class="msg">Email not sent: ${esc(r.emailError)}</div>` : ''), true);
}
function showInviteLink(r, label) {
  const who = label || r.name || r.email || '';
  const msg = `${who ? `Hi ${who.split(/[ @]/)[0]}! ` : 'Hi! '}Here’s your invite to PeptideTracker — tap to create your account (you’ll pick your own username and password):\n${r.link}\n\nThe link works once and expires in 7 days.`;
  usersMsg((r.emailed ? `<div class="new-pass">Invite emailed to <b>${esc(r.email)}</b>.</div>` : '')
    + shareBox(r.emailed ? 'Or text them the link:' : `Invite link${who ? ` for <b>${esc(who)}</b>` : ''}:`, msg), true);
}
const nuMode = () => document.querySelector('input[name="nuMode"]:checked').value;
function updateAddForm() {
  const invite = nuMode() === 'invite';
  $('nuInviteFields').hidden = !invite;
  $('nuTempFields').hidden = invite;
  $('nuSubmit').textContent = invite ? 'Create invite link' : 'Add user';
  $('nuSendWrap').hidden = !state.mailReady;
  $('nuInviteSendWrap').hidden = !state.mailReady || !$('nuInviteEmail').value.trim();
}
$('nuInviteEmail').addEventListener('input', updateAddForm);
document.querySelectorAll('input[name="nuMode"]').forEach(r => r.addEventListener('change', updateAddForm));
async function loadUsersTab() {
  $('addUserForm').reset();
  document.querySelector('input[name="nuMode"][value="invite"]').checked = true; // links work with or without email
  $('nuPass').value = randomPassword();
  $('nuSend').checked = true;
  updateAddForm();
  usersMsg('');
  try { await renderUsers(); } catch (e) { usersMsg(esc(e.message)); }
}
$('nuGen').addEventListener('click', () => { $('nuPass').value = randomPassword(); });
$('addUserForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  usersMsg('');
  try {
    if (nuMode() === 'invite') {
      const email = $('nuInviteEmail').value.trim(), name = $('nuInviteName').value.trim();
      const r = await api('POST', '/api/invites', { email, name, sendEmail: !!email && state.mailReady && $('nuInviteSend').checked });
      $('nuInviteEmail').value = ''; $('nuInviteName').value = '';
      updateAddForm();
      await renderUsers();
      return showInviteLink(r, name);
    }
    const name = $('nuName').value.trim(), pass = $('nuPass').value, email = $('nuEmail').value.trim();
    if (!name) return usersMsg('Enter a username.');
    const r = await api('POST', '/api/users', {
      user: name, password: pass, email, firstName: $('nuFirst').value.trim(), lastName: $('nuLast').value.trim(),
      sendInvite: !!email && state.mailReady && $('nuSend').checked,
    });
    await renderUsers();
    ['nuName', 'nuEmail', 'nuFirst', 'nuLast'].forEach(id => ($(id).value = ''));
    $('nuPass').value = randomPassword();
    showSent(name, pass, r, r.firstName);
  } catch (e) { usersMsg(esc(e.message)); }
});
async function onUsersClick(ev) {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const u = usersCache.find(x => x.id === (btn.dataset.edit || btn.dataset.reset || btn.dataset.remove));
  usersMsg('');
  try {
    if (btn.dataset.edit) return openAccount(u, u.user === user);
    if (btn.dataset.reset) {
      const pass = randomPassword();
      if (!confirm(`Reset ${u.user}'s password? They'll be signed out and must pick a new one.`)) return;
      const sendEmail = !!u.email && state.mailReady && confirm(`Email the new temporary password to ${u.email}?`);
      const r = await api('POST', `/api/users/${encodeURIComponent(u.id)}/password`, { password: pass, sendEmail });
      await renderUsers();
      return showSent(u.user, pass, r, u.firstName);
    }
    if (btn.dataset.remove) {
      if (!confirm(`Remove ${fullName(u) || u.user}? This permanently deletes their weigh-ins, shots and vials.`)) return;
      await api('DELETE', `/api/users/${encodeURIComponent(u.id)}`);
      return renderUsers();
    }
    if (btn.dataset.resend) {
      const r = await api('POST', `/api/invites/${encodeURIComponent(btn.dataset.resend)}/resend`, {});
      await renderUsers();
      return showInviteLink({ ...r, email: r.emailed ? btn.dataset.who : '' }, btn.dataset.who);
    }
    if (btn.dataset.cancel) {
      if (!confirm(`Cancel the invite for ${btn.dataset.email}? Their link will stop working.`)) return;
      await api('DELETE', `/api/invites/${encodeURIComponent(btn.dataset.cancel)}`);
      return renderUsers();
    }
  } catch (e) { usersMsg(esc(e.message)); }
}
$('userList').addEventListener('click', onUsersClick);
$('inviteList').addEventListener('click', onUsersClick);

// ---------- email settings (admin only) ----------
function fillMail(c) {
  $('mHost').value = c.host || '';
  $('mPort').value = c.port || '';
  $('mSecure').value = c.secure ? 'ssl' : 'starttls';
  $('mUser').value = c.user || '';
  $('mPass').value = '';
  $('mPass').placeholder = c.hasPassword ? 'Saved — leave blank to keep it' : '16-letter app password';
  $('mFromName').value = c.fromName || 'PeptideTracker';
  $('mFromAddr').value = c.fromAddress || '';
  $('mAppUrl').value = c.appUrl || location.origin;
  // Only suggest a test address if the box is empty — never overwrite what you typed.
  if (!$('mTestTo').value.trim()) $('mTestTo').value = c.user || '';
  $('mailClear').hidden = !c.configured;
}
const mailMsg = (text, ok) => { $('mailMsg').className = `msg${ok ? ' ok' : ''}`; $('mailMsg').textContent = text; };
// ---------- admin: database backup & Grafana ----------
const dbForm = px => ({
  host: $(`${px}Host`).value.trim(), port: $(`${px}Port`).value.trim(), database: $(`${px}Db`).value.trim(),
  user: $(`${px}User`).value.trim(), password: $(`${px}Pass`).value, ssl: $(`${px}Ssl`).checked,
});
const bkMsg = (text, ok) => { $('bkMsg').className = `msg${ok ? ' ok' : ''}`; $('bkMsg').textContent = text; };
const randomWord = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const sqlName = v => (/^[a-z_][a-z0-9_]*$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`);
let gfPass = '', bkPass = '';
function updateBackupHelp() {
  const db = $('bkDb').value.trim() || 'peptidetracker', user = $('bkUser').value.trim() || 'peptidetracker';
  $('bkSql').textContent = `CREATE USER ${sqlName(user)} WITH PASSWORD '${bkPass}';\nCREATE DATABASE ${sqlName(db)} OWNER ${sqlName(user)};`;
  $('gfSql').textContent = `CREATE USER grafana_pt WITH PASSWORD '${gfPass}';
GRANT CONNECT ON DATABASE ${sqlName(db)} TO grafana_pt;
\\c ${sqlName(db)}
GRANT USAGE ON SCHEMA public TO grafana_pt;
GRANT SELECT ON pt_entries, pt_shots, pt_supplies, pt_people, pt_settings TO grafana_pt;`;
  $('gfHost').textContent = `${$('bkHost').value.trim() || 'your-db'}:${$('bkPort').value.trim() || 5432}`;
  $('gfDb').textContent = db;
}
function fillBackup(b) {
  const on = b.enabled;
  $('bkStatus').innerHTML = !on ? '<span class="muted">Off</span>'
    : b.lastError ? `<span class="bad">On, but failing: ${esc(b.lastError)}</span>`
    : `<span class="ok-text">On</span> · ${b.lastOk ? `last copied ${esc(timeAgo(b.lastOk))}` : 'starting…'}${b.host ? ` · ${esc(b.user)}@${esc(b.host)}/${esc(b.database)}` : ''}`;
  $('bkEnv').hidden = !b.envManaged;
  $('bkForm').hidden = b.envManaged;
  if (b.mode === 'app') {
    $('bkHost').value = b.host; $('bkPort').value = b.port; $('bkDb').value = b.database; $('bkUser').value = b.user; $('bkSsl').checked = b.ssl;
    $('bkPass').value = ''; $('bkPass').placeholder = b.hasPassword ? '(saved — leave blank to keep)' : '';
  }
  $('bkSave').textContent = b.mode === 'app' ? 'Save changes' : 'Save & turn on';
  $('bkNow').hidden = $('bkOff').hidden = b.mode !== 'app';
  $('gfDownload').classList.toggle('disabled', !on);
  updateBackupHelp();
}
async function loadBackupTab() {
  bkMsg('');
  gfPass ||= randomWord(); bkPass ||= randomWord();
  try { fillBackup(await api('GET', '/api/admin/backup')); } catch (e) { bkMsg(e.message); }
}
for (const id of ['bkHost', 'bkPort', 'bkDb', 'bkUser']) $(id).addEventListener('input', updateBackupHelp);
$('bkTest').addEventListener('click', async () => {
  bkMsg('Connecting…', true);
  try {
    const r = await api('POST', '/api/admin/backup/test', dbForm('bk'));
    bkMsg(r.existing ? `Connected. This database already has a backup (${r.existing.users} people, ${r.existing.shots} shots, ${r.existing.entries} weigh-ins).` : 'Connected — the database is ready.', true);
  } catch (e) { bkMsg(e.message); }
});
async function saveBackup(overwrite = false) {
  bkMsg('Saving and copying everything…', true);
  const res = await fetch('/api/admin/backup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dbForm('bk'), overwrite }) });
  const r = await res.json().catch(() => ({}));
  if (res.status === 409 && r.existing) {
    const e = r.existing;
    if (confirm(`That database already has a PeptideTracker backup: ${e.users} people, ${e.shots} shots, ${e.entries} weigh-ins.\n\nReplace it with this install's data? (Cancel to keep it. To bring that data here instead, use "Restore from a backup" on a fresh install.)`)) return saveBackup(true);
    return bkMsg('Nothing changed.');
  }
  if (!res.ok) return bkMsg(r.error || `Failed (${res.status})`);
  fillBackup(r);
  bkMsg('Backup is on. Everything has been copied.', true);
  refresh().catch(() => {});
}
$('bkForm').addEventListener('submit', ev => { ev.preventDefault(); saveBackup().catch(e => bkMsg(e.message)); });
for (const id of ['bkNow', 'bkNowEnv']) $(id).addEventListener('click', async () => {
  try { fillBackup(await api('POST', '/api/admin/backup/now', {})); bkMsg('Backed up.', true); } catch (e) { bkMsg(e.message); }
});
$('bkOff').addEventListener('click', async () => {
  if (!confirm('Turn off the database backup? What’s already in the database is kept; it just stops getting updates.')) return;
  try { fillBackup(await api('DELETE', '/api/admin/backup')); bkMsg('Backup turned off.', true); refresh().catch(() => {}); } catch (e) { bkMsg(e.message); }
});

// ---------- admin: getting-set-up checklist ----------
async function renderChecklist() {
  if (role !== 'admin') return;
  let people = 1;
  try { people = (await api('GET', '/api/users')).length; } catch {}
  const items = [
    [true, 'Admin account created'],
    [state.mailReady, 'Email for invites, password resets and summaries', 'email', 'Set up email'],
    [people > 1, 'Invite the people who’ll use it (optional)', 'users', 'Add people'],
    [!!state.sync?.enabled, 'Database backup to PostgreSQL (optional)', 'backup', 'Set up backup'],
    [location.protocol === 'https:', 'HTTPS address — needed for the phone app and shot reminders (see the README: reverse proxy)'],
  ];
  const done = items.filter(i => i[0]).length;
  $('setupChecklist').hidden = done === items.length;
  $('checklistItems').innerHTML = items.map(([ok, text, tab, btn]) => `<li class="${ok ? 'done' : ''}"><span class="tick">${ok ? '✓' : '○'}</span><span>${esc(text)}</span>${!ok && tab ? `<button type="button" class="linkish" data-goto-tab="${tab}">${esc(btn)} ›</button>` : ''}</li>`).join('');
}
$('checklistItems').addEventListener('click', ev => {
  const b = ev.target.closest('[data-goto-tab]');
  if (b) location.hash = b.dataset.gotoTab === 'users' ? '#admin' : `#admin/${b.dataset.gotoTab}`;
});

// ---------- first-time setup: restore from a backup ----------
$('restoreLink').addEventListener('click', () => { showCard('restoreForm'); $('restoreMsg').textContent = ''; $('rsHost').focus(); });
$('restoreBack').addEventListener('click', () => showAuth(true));
$('restoreForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('restoreMsg').className = 'msg'; $('restoreMsg').textContent = 'Connecting and copying…';
  $('restoreBtn').disabled = true;
  try {
    const r = await api('POST', '/api/setup/restore', dbForm('rs'));
    showAuth(false);
    $('authMsg').className = 'msg ok';
    $('authMsg').textContent = `Restored ${r.users} ${r.users === 1 ? 'person' : 'people'}, ${r.shots} shots and ${r.entries} weigh-ins. Sign in with your usual login.`;
  } catch (e) { $('restoreMsg').textContent = e.message; }
  finally { $('restoreBtn').disabled = false; }
});

async function loadEmailTab() {
  mailMsg('');
  $('mTestTo').value = '';
  try { fillMail(await api('GET', '/api/mail')); } catch (e) { mailMsg(e.message); }
}
$('mailGmail').addEventListener('click', () => {
  $('mHost').value = 'smtp.gmail.com'; $('mPort').value = 587; $('mSecure').value = 'starttls';
  $('mUser').focus();
});
$('mSecure').addEventListener('change', () => { $('mPort').value = $('mSecure').value === 'ssl' ? 465 : 587; });

async function saveMail() {
  const c = await api('PUT', '/api/mail', {
    host: $('mHost').value.trim(), port: Number($('mPort').value), secure: $('mSecure').value === 'ssl',
    user: $('mUser').value.trim(), pass: $('mPass').value,
    fromName: $('mFromName').value.trim(), fromAddress: $('mFromAddr').value.trim(), appUrl: $('mAppUrl').value.trim(),
  });
  fillMail(c);
  state.mailReady = true;
  return c;
}
$('mailForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try { await saveMail(); mailMsg('Saved.', true); } catch (e) { mailMsg(e.message); }
});
$('mTest').addEventListener('click', async () => {
  const to = $('mTestTo').value.trim();
  if (!to) return mailMsg('Enter an address to send the test to.');
  mailMsg('Sending…', true);
  try {
    await saveMail();
    await api('POST', '/api/mail/test', { to });
    mailMsg(`Test email sent to ${to}. Check the inbox (and spam).`, true);
  } catch (e) { mailMsg(e.message); }
});
$('mailClear').addEventListener('click', async () => {
  if (!confirm('Remove the email settings? Invites won’t be emailed until you set them up again.')) return;
  fillMail(await api('DELETE', '/api/mail'));
  state.mailReady = false;
  mailMsg('Removed.', true);
});

// ---------- main page layout ----------
const SECTIONS = [
  ['logCard', 'Log weight', true], ['nextCard', 'Next shots'], ['hero', 'Projection', true], ['stats', 'Stats', true],
  ['progressCard', 'Progress', true], ['chartCard', 'Weight chart', true], ['doseCard', 'Dose & results', true], ['shotCard', 'Shots & vials'],
  ['goalCard', 'Goal', true], ['historyCard', 'History', true],
];
function layoutOrder(saved) {
  const ids = SECTIONS.map(x => x[0]);
  const order = (saved || []).filter(x => ids.includes(x));
  return [...new Set([...order, ...ids])];
}
function applyLayout() {
  document.body.classList.toggle('no-weight', state.settings.trackWeight === false);
  const main = $('appView'), end = main.querySelector('.disclaimer');
  for (const id of layoutOrder(state.settings.layout)) main.insertBefore($(id), end);
}

// ---------- next shots (short list, soonest first) ----------
const DAY0 = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function whenText(due, state_) {
  if (state_ === 'overdue') return { text: `Overdue · was due ${fmtDay(due)}`, cls: 'over' };
  if (state_ === 'due-today') return { text: 'Today', cls: 'due' };
  if (due == null) return { text: 'As needed', cls: '' };
  const days = Math.round((DAY0(due) - DAY0(Date.now())) / 86400000);
  return { text: days === 1 ? `Tomorrow · ${fmtDay(due)}` : `In ${days} days · ${fmtDay(due)}`, cls: '' };
}
function renderNext() {
  const card = $('nextCard');
  if (state.settings.showShots === false) { card.hidden = true; return; }
  const now = Date.now(), tomorrow = DAY0(now) + 86400000 + 3600000;
  const rows = [];
  // Main GLP-1
  const main = mainList();
  if (main.length) {
    const st = shotStatus(main, state.settings.shotDay, now);
    let due = st.due, s_ = st.state;
    if (s_ === 'done-today') { due = shotStatus(main, state.settings.shotDay, tomorrow).due ?? nextShotDue(main); s_ = 'done'; }
    if (due == null) due = nextShotDue(main);
    const last = main.at(-1);
    const rec = planOn() ? recommendDose(main, state.settings.plan, now) : null;
    const mg = rec ? rec.doseMg : last.doseMg;
    const conc = currentConc();
    rows.push({ name: last.name, due, state: s_, dose: `${fmtMg(mg)}${conc ? ` (${trim(mgToUnits(mg, conc))} units)` : ''}${rec?.stepUp ? ' · dose increase' : ''}`, med: null });
  }
  // Everything on its own schedule
  for (const p of protocols()) {
    if (extrasFor(p.name).hidden) continue;
    const st = protocolStatus(p, doses(), now);
    let due = st.due, s_ = st.state;
    if (s_ === 'done-today') {
      const n = protocolStatus(p, doses().filter(x => x.t < DAY0(now)), tomorrow); // next one after today
      due = p.freq === 'asneeded' ? null : (n.state === 'due-today' ? DAY0(tomorrow) : n.due);
      s_ = 'done';
    }
    if (s_ === 'as-needed') due = null;
    rows.push({ name: p.name, due, state: s_, dose: protoDoseText(p).txt, med: p.name });
  }
  card.hidden = !rows.length;
  const rank = r => (r.state === 'overdue' ? 0 : r.state === 'due-today' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (a.due ?? Infinity) - (b.due ?? Infinity));
  $('nextList').innerHTML = rows.map(r => {
    const w = r.state === 'done' ? { text: `✓ Done today${r.due ? ` · next ${fmtDay(r.due)}` : ''}`, cls: 'done' } : whenText(r.due, r.state);
    return `<div class="next-row">
      <span class="nname">${esc(r.name)}</span>
      <span class="nwhen ${w.cls}">${esc(w.text)}</span>
      <span class="ndose">${esc(r.dose)}</span>
      <span class="nbtns">${r.state === 'due-today' || r.state === 'overdue'
        ? `<button type="button" class="act primary" data-quick-log="${esc(r.med || '')}" title="Log ${esc(r.dose)} now">✓ Log</button><button type="button" class="act" data-next-log="${esc(r.med || '')}" aria-label="Log with details">⋯</button>`
        : `<button type="button" class="act" data-next-log="${esc(r.med || '')}">Log</button>`}</span>
    </div>`;
  }).join('');
}
$('nextList').addEventListener('click', async ev => {
  const q = ev.target.closest('[data-quick-log]');
  if (q) { q.disabled = true; try { await quickLog(q.dataset.quickLog); } finally { q.disabled = false; } return; }
  const b = ev.target.closest('[data-next-log]');
  if (b) openShotDialog(null, b.dataset.nextLog ? { med: b.dataset.nextLog } : {});
});

// ---------- medications page (#meds) ----------
// Every medication you have: from schedules, settings, vials, shots and inventory.
function allMeds() {
  const map = new Map();
  const add = n => { if (n && n.trim() && !map.has(lc(n))) map.set(lc(n), n.trim()); };
  protocols().forEach(p => add(p.name));
  Object.values(state.settings.medExtras || {}).forEach(x => add(x.name));
  [...state.supplies].reverse().forEach(v => add(v.name));
  [...state.shots].reverse().forEach(x => add(x.name));
  invItems('peptide').forEach(x => add(x.name));
  return [...map.values()];
}
const mainNames = () => allMeds().filter(n => !protocolFor(protocols(), n) && (extrasFor(n).kind === 'main' || state.shots.some(x => lc(x.name) === lc(n)) || state.supplies.some(x => lc(x.name) === lc(n))));
function medCard(name) {
  const p = protocolFor(protocols(), name);
  const isMain = !p && isKnownMed(name);
  const ex = extrasFor(name);
  const rows = [];
  if (p) {
    const { txt } = protoDoseText(p);
    rows.push(`${protoWhen(p)} · next dose <b>${esc(txt)}</b>`);
  } else if (isMain) {
    const st = state.settings;
    const plan = planOn() ? recommendDose(mainList(), st.plan, Date.now()) : null;
    rows.push([st.shotDay != null ? `Shot day: <b>${WEEKDAYS[st.shotDay]}</b>` : 'No shot day set', plan ? `Dose plan: next <b>${trim(plan.doseMg)} mg</b>` : 'Dose plan off'].join(' · '));
  } else rows.push('<span class="warn-tag">Not set up yet</span>');
  rows.push(`Sites: ${esc(rotationFor(name).join(', '))}`);
  const open = state.supplies.filter(v => !v.done && lc(v.name) === lc(name));
  const stock = invItems('peptide').filter(x => lc(x.name) === lc(name)).reduce((n, x) => n + x.qty, 0);
  const use = vialToUse(name);
  const left = use && use.kind === 'vial' ? usage(use, state.shots).leftMl : null;
  rows.push([
    `${open.length} open vial${open.length === 1 ? '' : 's'}${left != null ? ` (${trim(left)} mL left in the one in use)` : ''}`,
    `${stock} in stock`,
    ex.vialMg || ex.waterMl ? `new vials: ${[ex.vialMg && `${trim(ex.vialMg)} mg`, ex.waterMl && `${trim(ex.waterMl)} mL`, ex.price != null && money(ex.price)].filter(Boolean).join(' + ')}` : null,
  ].filter(Boolean).join(' · '));
  const ro = state.settings.reorderOn === false ? null : reorderPlan(state, Date.now(), state.settings.reorderLead ?? 10).find(r => lc(r.name) === lc(name) || (r.key === 'main' && isMain));
  if (ro) rows.push(`<span class="${ro.orderSoon ? 'warn-tag' : ''}">Supply lasts ~${ro.daysLeft} days · order by ${fmtDay(ro.orderBy)}</span>`);
  const last = shotsOf(doses(), name).at(-1);
  if (last) rows.push(`Last dose: ${fmtDay(last.t)} · ${esc(fmtMg(last.doseMg))}${last.units != null ? ` (${trim(last.units)} units)` : ''}`);
  const badge = p ? esc(describeProtocol(p, fmtAmount)) : isMain ? 'Main GLP-1' : 'New';
  return `<div class="med-card" data-med-card="${esc(name)}">
    <div class="mhead"><span class="mname">${esc(name)}</span><span class="badge">${badge}</span></div>
    ${rows.map(r => `<div class="mrow">${r}</div>`).join('')}
    <div class="mactions">
      <button type="button" class="primary" data-med-edit>Edit</button>
      ${state.settings.showShots !== false ? '<button type="button" data-med-log>Log dose</button>' : ''}
      <button type="button" data-med-vial>+ Vial</button>
    </div>
  </div>`;
}
function renderMeds() {
  if ($('medsView').hidden) return;
  const meds = allMeds();
  const shown = meds.filter(n => !extrasFor(n).hidden);
  const hidden = meds.filter(n => extrasFor(n).hidden);
  // Medications with open vials or a schedule first.
  const active = n => (protocolFor(protocols(), n) ? 2 : 0) + (state.supplies.some(v => !v.done && lc(v.name) === lc(n)) ? 1 : 0);
  shown.sort((a, b) => active(b) - active(a) || a.localeCompare(b));
  $('medsList').innerHTML = shown.length ? shown.map(medCard).join('') : '<div class="empty card">No medications yet. Tap “+ Add medication”.</div>';
  $('medsHiddenWrap').hidden = !hidden.length;
  $('medsHiddenSum').textContent = `Hidden (${hidden.length})`;
  $('medsHidden').innerHTML = hidden.map(medCard).join('');
}
$('medsView').addEventListener('click', ev => {
  const card = ev.target.closest('[data-med-card]');
  if (!card) return;
  const name = card.dataset.medCard;
  if (ev.target.closest('[data-med-edit]')) openMedEditor(name);
  if (ev.target.closest('[data-med-log]')) openShotDialog(null, protocolFor(protocols(), name) ? { med: name } : {});
  if (ev.target.closest('[data-med-vial]')) openSupplyDialog(null, name);
});
$('medsAdd').addEventListener('click', () => openMedEditor(null));
$('medsBtn').addEventListener('click', () => { document.querySelector('.menu').open = false; location.hash = '#meds'; });
$('medsBack').addEventListener('click', () => { history.pushState(null, '', location.pathname + location.search); route(); });

// ---------- medication editor ----------
// "14 days ≈ 2 doses" — so a weekly shot and a daily one can each get a lead time that makes sense.
function updateLeadHelp() {
  const days = numOrNull('mdLead') ?? (state.settings.reorderLead ?? 10);
  const name = $('mdName')?.value?.trim() || '';
  const perWeek = name ? dosesPerWeek(state, protocolFor(protocols(), name)) : 0;
  const doses = perWeek > 0 ? Math.round(days / 7 * perWeek * 10) / 10 : null;
  $('mdLeadHelp').textContent = `${days} day${days === 1 ? '' : 's'}${doses != null ? ` ≈ ${trim(doses)} dose${doses === 1 ? '' : 's'} at the current schedule` : ''}. Blank uses the default from Settings. Leave enough time to order and ship.`;
}
$('mdLead').addEventListener('input', updateLeadHelp);
let medEditor = { name: null, fromVial: false, custom: [] };
function renderMdSites(checked) {
  const custom = medEditor.custom;
  $('mdSites').innerHTML = [...SITES, ...custom].map(x => `<label><input type="checkbox" name="mdSite" value="${esc(x)}"${checked.includes(x) ? ' checked' : ''}> ${esc(x)}${custom.includes(x) ? `<button type="button" class="rm" data-rm-site="${esc(x)}" aria-label="Remove ${esc(x)}">×</button>` : ''}</label>`).join('');
}
const mdChecked = () => [...document.querySelectorAll('input[name="mdSite"]:checked')].map(x => x.value);
$('mdAddSite').addEventListener('click', () => {
  const name = $('mdNewSite').value.trim().replace(/[<>]/g, '').slice(0, 30);
  if (!name) return;
  const exists = [...SITES, ...medEditor.custom].find(x => x.toLowerCase() === name.toLowerCase());
  const checked = mdChecked();
  if (!exists) medEditor.custom.push(name);
  renderMdSites([...checked, exists || name]);
  $('mdNewSite').value = '';
});
$('mdNewSite').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('mdAddSite').click(); } });
$('mdSites').addEventListener('click', ev => {
  const rm = ev.target.closest('[data-rm-site]');
  if (!rm) return;
  ev.preventDefault();
  if (!confirm(`Remove “${rm.dataset.rmSite}” from every medication’s sites?`)) return;
  const checked = mdChecked().filter(x => x !== rm.dataset.rmSite);
  medEditor.custom = medEditor.custom.filter(x => x !== rm.dataset.rmSite);
  renderMdSites(checked);
});
function fillMainFields() {
  const st = state.settings, plan = st.plan || {};
  const firstShot = mainList()[0];
  $('setShotDay').value = st.shotDay == null ? '' : String(st.shotDay);
  $('planOn').checked = !!plan.enabled;
  $('planStart').value = plan.start ? localDateValue(plan.start) : (firstShot ? localDateValue(firstShot.t) : '');
  $('planStartDose').value = plan.startDose ?? 2.5;
  $('planStep').value = plan.step ?? 2.5;
  $('planEvery').value = plan.every ?? 4;
  $('planMax').value = plan.maxDose ?? 15;
}
function openMedEditor(name, opts = {}) {
  const existing = !!name && isKnownMed(name);
  const hasHistory = !!name && (state.shots.some(x => lc(x.name) === lc(name)) || state.supplies.some(x => lc(x.name) === lc(name)));
  medEditor = { name: existing ? name : null, fromVial: !!opts.fromVial, custom: [...(state.settings.customSites || [])] };
  $('medForm').reset();
  $('medMsg').textContent = '';
  $('medTitle').textContent = existing ? name : name ? `Set up ${name}` : 'Add medication';
  $('mdName').value = name || '';
  // Renaming would split a medication from its vials and shots, so names with history are fixed.
  $('mdName').readOnly = hasHistory;
  $('mdNameHint').hidden = true;
  document.querySelector(`input[name="sSched"][value="${defaultSchedMode(name)}"]`).checked = true;
  const ex = extrasFor(name);
  const lastVial = name ? [...state.supplies].reverse().find(v => lc(v.name) === lc(name) && v.kind === 'vial') : null;
  $('mdVialMg').value = ex.vialMg ?? lastVial?.mg ?? '';
  $('mdVialWater').value = ex.waterMl ?? lastVial?.waterMl ?? '';
  $('mdVialPrice').value = ex.price ?? lastVial?.price ?? '';
  $('mdUseWithin').value = ex.useWithin ?? '';
  $('mdLead').value = ex.reorderLead ?? '';
  $('mdLead').placeholder = `${state.settings.reorderLead ?? 10} (default)`;
  $('mdReorderBox').hidden = state.settings.reorderOn === false || state.settings.showShots === false;
  updateLeadHelp();
  fillSched(name || '');
  fillMainFields();
  const others = mainNames().filter(n => lc(n) !== lc(name));
  $('mainShared').textContent = others.length ? `Shot day and dose plan are shared by all your main GLP-1 medications (also: ${others.join(', ')}).` : '';
  renderMdSites(name ? rotationFor(name) : (state.settings.sites?.length ? state.settings.sites : SITES));
  $('medHide').hidden = !existing;
  $('medHide').textContent = ex.hidden ? 'Unhide' : 'Hide';
  updateSched();
  $('medDialog').showModal();
}
$('mdName').addEventListener('input', () => {
  nameHint('mdName', 'mdNameHint');
  if (!medEditor.name) document.querySelector(`input[name="sSched"][value="${defaultSchedMode($('mdName').value.trim())}"]`).checked = true;
  updateSched();
});
$('medDialog').addEventListener('input', ev => { if (['mdVialMg', 'mdVialWater'].includes(ev.target.id)) updateSched(); });
$('medCancel').addEventListener('click', () => $('medDialog').close());
async function saveMed({ hidden } = {}) {
  const name = $('mdName').value.trim();
  if (!name) { $('medMsg').textContent = 'Enter a name.'; return false; }
  if (!medEditor.name && isKnownMed(name) && !medEditor.fromVial) { $('medMsg').textContent = `${name} already exists — edit it from the list.`; return false; }
  const own = schedMode() === 'own';
  if (own && !(numOrNull('pAmount') > 0)) { $('medMsg').textContent = 'Enter the dose for the schedule.'; $('pAmount').focus(); return false; }
  const sites = mdChecked();
  if (!sites.length) { $('medMsg').textContent = 'Pick at least one injection site.'; return false; }
  const ex = extrasFor(name);
  const medExtras = { ...(state.settings.medExtras || {}) };
  medExtras[lc(name)] = {
    name, kind: own ? 'own' : 'main', sites,
    vialMg: numOrNull('mdVialMg'), waterMl: numOrNull('mdVialWater'), price: numOrNull('mdVialPrice'),
    useWithin: numOrNull('mdUseWithin') ? Math.round(numOrNull('mdUseWithin')) : null,
    reorderLead: numOrNull('mdLead') != null ? Math.round(numOrNull('mdLead')) : null,
    hidden: hidden ?? !!ex.hidden,
  };
  const body = {
    customSites: medEditor.custom,
    medExtras,
    protocols: [...protocols().filter(p => lc(p.name) !== lc(name)), ...(own ? [readSched(name)] : [])],
  };
  if (!own) {
    // Main GLP-1: shot day, dose plan and the main rotation live in the general settings.
    body.shotDay = $('setShotDay').value === '' ? null : Number($('setShotDay').value);
    body.plan = !$('planOn').checked ? { enabled: false } : {
      enabled: true,
      start: $('planStart').value ? dateInputToMs($('planStart').value) - 12 * 3600000 : null,
      startDose: numOrNull('planStartDose'), step: numOrNull('planStep'), every: numOrNull('planEvery'), maxDose: numOrNull('planMax'),
    };
    body.sites = sites;
  }
  try {
    await api('PUT', '/api/settings', body);
  } catch (e) { $('medMsg').textContent = e.message; return false; }
  $('medDialog').close();
  await refresh();
  if (medEditor.fromVial && $('supplyDialog').open) {
    if (lc($('sName').value) !== lc(name)) $('sName').value = name;
    $('supplyMsg').textContent = '';
    applyVialDefaults(); updateSupplyCalc(); updateVialSchedLine();
  }
  return true;
}
$('medForm').addEventListener('submit', async ev => { ev.preventDefault(); await saveMed(); });
$('medHide').addEventListener('click', async () => { await saveMed({ hidden: !extrasFor($('mdName').value).hidden }); });

// ---------- inventory page (#inventory) ----------
const DAY_MS = 86400000;
// Low stock (at/below "warn me at") and anything expiring within 30 days.
function invAlerts() {
  const out = [];
  for (const x of state.inventory || []) {
    if (x.lowAt != null && x.qty <= x.lowAt) {
      const what = x.kind === 'peptide' ? `vial${x.qty === 1 ? '' : 's'}` : x.kind === 'water' ? `sealed bottle${x.qty === 1 ? '' : 's'}` : (x.unit || 'left');
      out.push({ title: `Low stock: ${x.name}`, body: `${x.qty} ${what}${x.kind === 'water' ? ` + ${trim(x.openMl || 0)} mL open` : ''} (${x.code})` });
    }
    if (x.expires && x.qty > 0 && x.expires - Date.now() < 30 * DAY_MS) {
      out.push({ title: `${x.expires < Date.now() ? 'Expired' : 'Expiring soon'}: ${x.name}`, body: `${x.code} · expires ${fmtDate(x.expires)}` });
    }
  }
  return out;
}
function invRow(x) {
  const low = x.lowAt != null && x.qty <= x.lowAt;
  const meta = [];
  if (x.kind === 'peptide' && x.mg) meta.push(`${trim(x.mg)} mg per vial`);
  if (x.kind === 'water') meta.push(`${x.bottleMl ? `${trim(x.bottleMl)} mL bottles` : 'bottles'} · <b>${trim(x.openMl || 0)} mL</b> in the open one · <b>${trim(waterLeft(x))} mL</b> total`);
  if (x.kind === 'other' && x.perShot) meta.push('one used per shot');
  if (x.price != null) meta.push(`${money(x.price)} each`);
  if (x.lot) meta.push(`lot ${esc(x.lot)}`);
  if (x.received) meta.push(`received ${fmtShort(x.received)}`);
  if (x.expires) meta.push(x.expires < Date.now() ? `<span class="exp-tag">expired ${fmtShort(x.expires)}</span>` : `expires ${fmtShort(x.expires)}`);
  if (low) meta.push('<span class="warn-tag">low</span>');
  const unitLabel = x.kind === 'peptide' ? 'vials' : x.kind === 'water' ? 'sealed' : (x.unit || 'on hand');
  const used = x.kind === 'peptide' ? state.supplies.filter(v => v.invCode && v.invCode === x.code).length : 0;
  return `<div class="inv${low ? ' low' : ''}" data-inv="${esc(x.id)}">
    <div class="iname">${esc(x.name)}<span class="icode">${esc(x.code)}</span></div>
    <div class="iqty"><button type="button" data-step="-1" aria-label="One less">−</button><b>${x.qty}</b><button type="button" data-step="1" aria-label="One more">+</button></div>
    <div class="imeta">${unitLabel} · ${meta.join(' · ')}${used ? ` · ${used} mixed so far` : ''}</div>
    ${x.note ? `<div class="imeta">${esc(x.note)}</div>` : ''}
    <div class="iactions">
      ${x.kind === 'peptide' ? `<button type="button" class="primary" data-mix ${x.qty > 0 ? '' : 'disabled'}>Mix &amp; use one</button>` : ''}
      <button type="button" data-edit-inv>Edit</button>
    </div>
  </div>`;
}
function renderInventory() {
  if ($('invView').hidden) return;
  const inv = state.inventory || [];
  const group = (kind, el, empty) => {
    const list = inv.filter(x => x.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    $(el).innerHTML = list.length ? list.map(invRow).join('') : `<div class="empty">${empty}</div>`;
  };
  group('peptide', 'invPeptides', 'No powder vials in stock. Tap “+ Add item” to add what’s on hand.');
  group('water', 'invWater', 'Add your bacteriostatic water to track how much is left.');
  group('other', 'invOther', 'Syringes, alcohol pads, sharps containers — anything you want to count.');
  const open = state.supplies.filter(v => !v.done);
  $('invInUse').innerHTML = open.length ? open.map(v => {
    const u = usage(v, state.shots);
    const left = v.kind === 'vial' && u.leftMl != null ? `${trim(u.leftMl)} mL left (${fmtMg(u.leftMg)})` : u.left != null ? `${u.left} of ${v.count} left` : '';
    return `<div class="inv"><div class="iname">${esc(supplyLabel(v))}${v.invCode ? `<span class="icode">${esc(v.invCode)}</span>` : ''}</div>
      <div class="imeta">${left}${left ? ' · ' : ''}${takenText(v)}</div>
      <div class="iactions"><button type="button" data-open-vial="${esc(v.id)}">Edit</button></div></div>`;
  }).join('') : '<div class="empty">No vials in use.</div>';
  const pepVials = inv.filter(x => x.kind === 'peptide').reduce((n, x) => n + x.qty, 0);
  const water = inv.filter(x => x.kind === 'water').reduce((n, x) => n + waterLeft(x), 0);
  const value = inv.reduce((n, x) => n + (x.price || 0) * x.qty, 0);
  $('invStats').innerHTML = [
    ['Powder vials', pepVials], ['In use', open.length], ['Bac water', `${trim(water)} mL`], ['Stock value', money0(value)],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  renderReorder();
  $('invAlerts').innerHTML = invAlerts().map(a => `<div class="banner refill"><div class="title">${esc(a.title)}</div><div class="body">${esc(a.body)}</div></div>`).join('');
}

function renderReorder() {
  const lead = state.settings.reorderLead ?? 10;
  const plan = state.settings.showShots === false || state.settings.reorderOn === false ? [] : reorderPlan(state, Date.now(), lead);
  $('reorderCard').hidden = !plan.length;
  $('reorderList').innerHTML = plan.map(r => {
    const parts = [r.openMg > 0 && `${fmtMg(r.openMg)} in open vials`, r.invMg > 0 && `${fmtMg(r.invMg)} in stock`].filter(Boolean).join(' + ') || 'Nothing on hand';
    return `<div class="reorder-row${r.orderSoon ? ' soon' : ''}">
      <div class="rname">${esc(r.name)}<span class="rdays">${r.daysLeft} days left</span></div>
      <div class="rmeta">${parts} · ${esc(fmtMg(r.mgPerWeek))}/week</div>
      <div class="rmeta">Runs out ~<b>${fmtDay(r.runOut)}</b> · <b class="${r.orderSoon ? 'warn-tag' : ''}">order by ${fmtDay(r.orderBy)}</b> <span class="muted">(${r.lead} days ahead)</span>${r.price != null ? ` · about ${money(r.price)} per vial` : ''}</div>
    </div>`;
  }).join('');
  $('reorderHelp').textContent = `Based on your current doses and schedules. Order-ahead days: ${lead} by default (Settings), or each medication's own (Medications → Edit).`;
}

// Item editor
let editingInvId = null;
const invKind = () => document.querySelector('input[name="iKind"]:checked').value;
function updateInvForm() {
  const k = invKind();
  document.querySelectorAll('#invForm .i-pep').forEach(e => (e.hidden = k !== 'peptide'));
  document.querySelectorAll('#invForm .i-water').forEach(e => (e.hidden = k !== 'water'));
  document.querySelectorAll('#invForm .i-other').forEach(e => (e.hidden = k !== 'other'));
  $('iQtyLabel').textContent = k === 'peptide' ? 'Vials on hand' : k === 'water' ? 'Sealed bottles' : 'How many on hand';
  $('iName').placeholder = k === 'peptide' ? 'e.g. BPC-157' : k === 'water' ? 'e.g. Bacteriostatic water' : 'e.g. Insulin syringes';
}
document.querySelectorAll('input[name="iKind"]').forEach(r => r.addEventListener('change', updateInvForm));
function openInvDialog(x, kind = 'peptide') {
  editingInvId = x ? x.id : null;
  $('invForm').reset();
  $('invTitle').textContent = x ? `Edit ${x.name}` : 'Add to inventory';
  $('invDelete').hidden = !x;
  $('invMsg').textContent = '';
  const src = x || { kind, qty: 1, openMl: 0 };
  document.querySelector(`input[name="iKind"][value="${src.kind}"]`).checked = true;
  document.querySelectorAll('input[name="iKind"]').forEach(r => (r.disabled = !!x));
  $('iName').value = src.name || '';
  $('iCode').value = src.code || '';
  $('iMg').value = src.mg ?? '';
  $('iQty').value = src.qty ?? 0;
  $('iBottle').value = src.bottleMl ?? '';
  $('iOpen').value = src.openMl ?? 0;
  $('iUnit').value = src.unit || '';
  $('iPrice').value = src.price ?? '';
  $('iLow').value = src.lowAt ?? '';
  $('iLot').value = src.lot || '';
  $('iReceived').value = src.received ? localDateValue(src.received) : (x ? '' : localDateValue(Date.now()));
  $('iExpires').value = src.expires ? localDateValue(src.expires) : '';
  $('iPerShot').checked = !!src.perShot;
  $('iNote').value = src.note || '';
  updateInvForm();
  $('invDialog').showModal();
}
function readInvForm() {
  return {
    kind: invKind(), name: $('iName').value.trim(), code: $('iCode').value.trim(),
    mg: numOrNull('iMg'), qty: numOrNull('iQty') ?? 0, bottleMl: numOrNull('iBottle'), openMl: numOrNull('iOpen'),
    unit: $('iUnit').value.trim(), price: numOrNull('iPrice'), lowAt: numOrNull('iLow'), lot: $('iLot').value.trim(),
    received: $('iReceived').value ? dateInputToMs($('iReceived').value) : null,
    expires: $('iExpires').value ? dateInputToMs($('iExpires').value) : null,
    perShot: $('iPerShot').checked, note: $('iNote').value.trim(),
  };
}
$('invForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    if (editingInvId) await api('PUT', `/api/inventory/${encodeURIComponent(editingInvId)}`, readInvForm());
    else await api('POST', '/api/inventory', readInvForm());
    $('invDialog').close();
    await refresh();
    renderInventory();
  } catch (e) { $('invMsg').textContent = e.message; }
});
$('invCancel').addEventListener('click', () => $('invDialog').close());
$('invDelete').addEventListener('click', async () => {
  if (!editingInvId || !confirm('Delete this item from your inventory?')) return;
  await api('DELETE', `/api/inventory/${encodeURIComponent(editingInvId)}`);
  $('invDialog').close();
  await refresh();
  renderInventory();
});
$('invAdd').addEventListener('click', () => openInvDialog(null));
$('invView').addEventListener('click', async ev => {
  const openVial = ev.target.closest('[data-open-vial]');
  if (openVial) return openSupplyDialog(supplyById(openVial.dataset.openVial));
  const row = ev.target.closest('[data-inv]');
  if (!row) return;
  const x = (state.inventory || []).find(i => i.id === row.dataset.inv);
  if (ev.target.closest('[data-edit-inv]')) return openInvDialog(x);
  if (ev.target.closest('[data-mix]')) return openSupplyDialog(null, null, { fromInv: x.id });
  const step = ev.target.closest('[data-step]');
  if (step) {
    const qty = Math.max(0, x.qty + Number(step.dataset.step));
    if (qty === x.qty) return;
    try {
      await api('PUT', `/api/inventory/${encodeURIComponent(x.id)}`, { ...x, qty });
      await refresh();
      renderInventory();
    } catch (e) { alert(e.message); }
  }
});
$('invBtn').addEventListener('click', () => {
  document.querySelector('.menu').open = false;
  location.hash = '#inventory';
});
$('invBack').addEventListener('click', async () => {
  history.pushState(null, '', location.pathname + location.search);
  route();
});

// ---------- admin page (#admin, #admin/email) ----------
const ADMIN_TABS = { users: { panel: 'adminUsers', load: loadUsersTab }, email: { panel: 'adminEmail', load: loadEmailTab }, backup: { panel: 'adminBackup', load: loadBackupTab } };
function route() {
  if ($('authView').hidden === false) return;
  const page = { '#inventory': 'invView', '#meds': 'medsView', '#photos': state.settings.photos === true ? 'photosView' : null }[location.hash] || null;
  if (page) {
    for (const v of ['appView', 'adminView', 'invView', 'medsView', 'photosView']) $(v).hidden = v !== page;
    window.scrollTo(0, 0);
    if (page === 'invView') renderInventory(); else if (page === 'medsView') renderMeds(); else loadPhotos();
    return;
  }
  $('invView').hidden = true;
  $('medsView').hidden = true;
  $('photosView').hidden = true;
  const m = location.hash.match(/^#admin(?:\/(\w+))?$/);
  if (!m || role !== 'admin') {
    $('adminView').hidden = true;
    $('appView').hidden = false;
    return;
  }
  const tab = ADMIN_TABS[m[1]] ? m[1] : 'users';
  $('appView').hidden = true;
  $('adminView').hidden = false;
  for (const [name, t] of Object.entries(ADMIN_TABS)) {
    $(t.panel).hidden = name !== tab;
    document.querySelector(`.tabs [data-tab="${name}"]`).setAttribute('aria-selected', String(name === tab));
  }
  window.scrollTo(0, 0);
  ADMIN_TABS[tab].load();
  renderChecklist();
}
window.addEventListener('hashchange', route);
$('adminBtn').addEventListener('click', () => {
  document.querySelector('.menu').open = false;
  location.hash = '#admin';
});
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
  location.hash = b.dataset.tab === 'users' ? '#admin' : `#admin/${b.dataset.tab}`;
}));
$('adminBack').addEventListener('click', async () => {
  history.pushState(null, '', location.pathname + location.search);
  route();
  await refresh(); // pick up anything changed on the admin page (e.g. email set up)
});

// ---------- progress photos (#photos, optional) ----------
let photos = [];
const photoUrl = p => `/api/photos/${encodeURIComponent(p.id)}/image`;
const photoCap = p => `${fmtDate(p.t)}${p.note ? ` · ${p.note}` : ''}${weightNear(p.t) ? ` · ${fmtW(weightNear(p.t).weight)}` : ''}`;
// The weigh-in closest to a photo's date (within 3 days).
function weightNear(t) {
  let best = null;
  for (const e of state.entries) if (Math.abs(e.t - t) <= 3 * DAY && (!best || Math.abs(e.t - t) < Math.abs(best.t - t))) best = e;
  return best;
}
async function loadPhotos() {
  try { photos = await api('GET', '/api/photos'); } catch { photos = []; }
  renderPhotos();
}
function renderPhotos() {
  $('photoGrid').innerHTML = photos.length
    ? [...photos].reverse().map(p => `<button type="button" class="photo" data-photo="${esc(p.id)}"><img src="${photoUrl(p)}" alt="" loading="lazy"><span>${esc(fmtShort(p.t))}</span></button>`).join('')
    : '<div class="empty">No photos yet. Tap “+ Add photo”. Same pose and lighting each time makes changes easier to see.</div>';
  $('compareCard').hidden = photos.length < 2;
  if (photos.length < 2) return;
  const opts = photos.map(p => `<option value="${esc(p.id)}">${esc(photoCap(p))}</option>`).join('');
  const a = $('cmpA').value, b = $('cmpB').value;
  $('cmpA').innerHTML = opts; $('cmpB').innerHTML = opts;
  $('cmpA').value = photos.some(p => p.id === a) ? a : photos[0].id;
  $('cmpB').value = photos.some(p => p.id === b) ? b : photos.at(-1).id;
  showCompare();
}
function showCompare() {
  for (const k of ['A', 'B']) {
    const p = photos.find(x => x.id === $(`cmp${k}`).value);
    if (!p) continue;
    $(`cmpImg${k}`).src = photoUrl(p);
    $(`cmpCap${k}`).textContent = photoCap(p);
  }
}
$('cmpA').addEventListener('change', showCompare);
$('cmpB').addEventListener('change', showCompare);
// Shrink to at most 1600 px and re-encode as JPEG (also drops location data from the camera).
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new Error('Couldn’t read that picture'))), 'image/jpeg', 0.85));
}
$('photoFile').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const blob = await shrinkPhoto(file);
    const t = file.lastModified && Math.abs(file.lastModified - Date.now()) < 365 * DAY ? file.lastModified : Date.now();
    const res = await fetch(`/api/photos?t=${t}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `Upload failed (${res.status})`);
    await loadPhotos();
    openPhoto(r.id);
  } catch (e) { alert(e.message); }
});
let editingPhotoId = null;
function openPhoto(id) {
  const p = photos.find(x => x.id === id);
  if (!p) return;
  editingPhotoId = id;
  $('photoBig').src = photoUrl(p);
  $('phDate').value = localDateValue(p.t);
  $('phNote').value = p.note || '';
  $('photoMsg').textContent = '';
  $('photoDialog').showModal();
}
$('photoGrid').addEventListener('click', ev => { const b = ev.target.closest('[data-photo]'); if (b) openPhoto(b.dataset.photo); });
$('photoCancel').addEventListener('click', () => $('photoDialog').close());
$('photoForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('PUT', `/api/photos/${encodeURIComponent(editingPhotoId)}`, { t: dateInputToMs($('phDate').value), note: $('phNote').value });
    $('photoDialog').close();
    await loadPhotos();
  } catch (e) { $('photoMsg').textContent = e.message; }
});
$('photoDelete').addEventListener('click', async () => {
  if (!confirm('Delete this photo?')) return;
  await api('DELETE', `/api/photos/${encodeURIComponent(editingPhotoId)}`);
  $('photoDialog').close();
  await loadPhotos();
});
$('photosBtn').addEventListener('click', () => { document.querySelector('.menu').open = false; location.hash = '#photos'; });
$('photosBack').addEventListener('click', () => { history.pushState(null, '', location.pathname + location.search); route(); });

// ---------- start ----------
setEditMode(null);
(async () => {
  try {
    const params = new URLSearchParams(location.search);
    const invite = params.get('invite'), reset = params.get('reset'), invitedUser = params.get('u');
    // Don't leave one-time tokens sitting in the address bar or history.
    if (invite || reset) history.replaceState(null, '', location.pathname);
    if (invite) return await openInvite(invite);
    if (reset) return await openReset(reset);
    const s = await whoAmI();
    if (s.loggedIn) {
      if (s.mustChange) showNewPassword(); else await showApp();
    } else {
      showAuth(s.setupNeeded);
      if (invitedUser && !s.setupNeeded) { $('authUser').value = invitedUser; $('authPass').focus(); }
    }
  } catch (e) {
    document.body.textContent = `Couldn't reach the server: ${e.message}`;
  }
})();
