// Weekly summary email and monthly data export.
import { combineShots } from '../public/protocols.js';
import { usage } from '../public/supplies.js';
import { reorderPlan, dueToday, fmtMg } from '../public/planning.js';

const DAY = 86400000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = t => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const r1 = v => Math.round(v * 10) / 10;

export function weeklySummary(data, { name, appUrl, now = Date.now() }) {
  const s = data.settings || {};
  const kg = s.unit === 'kg';
  const w = lb => `${r1(kg ? lb / 2.20462262 : lb)} ${kg ? 'kg' : 'lb'}`;
  const entries = [...(data.entries || [])].sort((a, b) => a.t - b.t);
  const sections = [];

  if (s.trackWeight !== false && entries.length) {
    const week = entries.filter(e => e.t > now - 7 * DAY);
    const before = entries.filter(e => e.t <= now - 7 * DAY).at(-1);
    const last = entries.at(-1);
    const lines = [`Current: <b>${w(last.weight)}</b>`];
    if (before) lines.push(`This week: <b>${last.weight - before.weight <= 0 ? '−' : '+'}${w(Math.abs(last.weight - before.weight))}</b>`);
    lines.push(`Since you started: ${last.weight - entries[0].weight <= 0 ? '−' : '+'}${w(Math.abs(last.weight - entries[0].weight))}`);
    lines.push(`${week.length} weigh-in${week.length === 1 ? '' : 's'} this week`);
    sections.push(['Weight', lines]);
  }
  if (s.showShots !== false) {
    const shots = combineShots(data.shots || [], s.protocols || []).filter(x => x.t > now - 7 * DAY);
    sections.push(['Shots this week', shots.length ? shots.map(x => `${day(x.t)} · ${esc(x.name)} ${x.units != null ? `${r1(x.units)} units (${fmtMg(x.doseMg)})` : fmtMg(x.doseMg)}`) : ['None logged']]);
    // What's coming up over the next 7 days.
    const upcoming = [];
    for (let i = 1; i <= 7; i++) {
      const t = new Date(now); t.setDate(t.getDate() + i); t.setHours(9, 0, 0, 0);
      for (const d of dueToday(data, t.getTime())) if (!d.overdue && !upcoming.some(u => u.key === d.key)) upcoming.push({ ...d, t: t.getTime() });
    }
    if (upcoming.length) sections.push(['Coming up', upcoming.map(u => `${day(u.t)} · ${esc(u.name)} ${esc(u.text)}`)]);
    const alerts = [];
    for (const r of s.reorderOn === false ? [] : reorderPlan(data, now, s.reorderLead ?? 10)) {
      if (r.orderSoon) alerts.push(`Order ${esc(r.name)} by ${day(r.orderBy)} (runs out around ${day(r.runOut)})`);
    }
    for (const v of (data.supplies || []).filter(v => !v.done)) {
      const u = usage(v, data.shots || []);
      const left = v.kind === 'pack' ? u.left : u.shotsLeft;
      if (left != null && left <= (s.refillAt ?? 3)) alerts.push(`${esc(v.name)} vial: ${left} dose${left === 1 ? '' : 's'} left`);
    }
    if (alerts.length) sections.push(['Heads up', alerts]);
  }

  const subject = `Your week in PeptideTracker`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
  <p>Hi ${esc(name)}, here's your week.</p>
  ${sections.map(([h, lines]) => `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#666;margin:18px 0 6px">${h}</h3>${lines.map(l => `<div>${l}</div>`).join('')}`).join('')}
  ${appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}" style="color:#2a78d6">Open PeptideTracker</a></p>` : ''}
  <p style="color:#888;font-size:12px">You can turn this email off in Settings.</p></div>`;
  const text = `Hi ${name}, here's your week.\n\n` + sections.map(([h, lines]) => `${h.toUpperCase()}\n${lines.map(l => '  ' + l.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')).join('\n')}`).join('\n\n') + (appUrl ? `\n\n${appUrl}` : '');
  return { subject, html, text };
}

// Monthly export: everything as JSON, plus CSVs that open in a spreadsheet.
export function exportFiles(data, name) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const iso = t => new Date(t).toISOString();
  const weights = ['date,weight_lb,note', ...(data.entries || []).map(e => [iso(e.t), e.weight, q(e.note)].join(','))].join('\n');
  const shots = ['date,medication,dose_mg,units,site,vial,note', ...(data.shots || []).map(x => {
    const v = (data.supplies || []).find(s => s.id === x.supplyId);
    return [iso(x.t), q(x.name), x.doseMg, x.units ?? '', q(x.site), q(v ? `${v.name} ${v.mg ?? ''} mg` : ''), q(x.note)].join(',');
  })].join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `peptidetracker-${String(name).replace(/[^\w.-]/g, '')}-${stamp}`;
  return [
    { filename: `${base}.json`, content: JSON.stringify(data, null, 2), contentType: 'application/json' },
    { filename: `${base}-weights.csv`, content: weights, contentType: 'text/csv' },
    { filename: `${base}-shots.csv`, content: shots, contentType: 'text/csv' },
  ];
}
