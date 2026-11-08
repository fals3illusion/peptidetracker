// Outgoing email (SMTP), configured by the admin. Used for user invites.
//
// mail.json: { host, port, secure, user, pass, fromName, fromAddress, appUrl }
//   secure: true = SSL on connect (port 465); false = STARTTLS (port 587, Gmail's usual)
// The SMTP password is never sent back to the browser.
import nodemailer from 'nodemailer';
import { jsonFile } from './store.js';

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
export const validEmail = v => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);

const clean = (v, max) => String(v ?? '').replace(/[\r\n]/g, '').trim().slice(0, max);

export function createMail(dataDir, { transportFactory } = {}) {
  const file = jsonFile(dataDir, 'mail.json', null);
  const read = () => file.read();

  function transport(cfg) {
    const opts = {
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      requireTLS: !cfg.secure, // never send the password over an unencrypted connection
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    };
    return transportFactory ? transportFactory(opts) : nodemailer.createTransport(opts);
  }

  return {
    configured: () => !!read()?.host,
    // Safe to show in the browser.
    publicConfig() {
      const c = read();
      if (!c) return { configured: false };
      const { pass, ...rest } = c;
      return { configured: true, ...rest, hasPassword: !!pass };
    },
    // For the database backup / restore.
    raw: read,
    restore(cfg) { if (cfg?.host) file.write(cfg); },

    // Save settings. Leaving the password blank keeps the old one.
    save(input) {
      const old = read() || {};
      // Fields that weren't sent keep their saved values.
      const b = { ...old, ...Object.fromEntries(Object.entries(input || {}).filter(([, v]) => v !== undefined)) };
      const port = Number(b.port);
      const cfg = {
        host: clean(b.host, 200),
        port,
        secure: b.secure === true,
        user: clean(b.user, 200),
        pass: typeof input?.pass === 'string' && input.pass !== '' ? input.pass.replace(/\s+/g, '') : old.pass || '',
        fromName: clean(b.fromName, 80) || 'PeptideTracker',
        fromAddress: clean(b.fromAddress, 254) || clean(b.user, 254),
        appUrl: clean(b.appUrl, 300).replace(/\/+$/, ''),
      };
      if (!/^[a-z0-9.-]+$/i.test(cfg.host)) throw new Error('Enter the SMTP server, e.g. smtp.gmail.com');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      if (!validEmail(cfg.fromAddress)) throw new Error('Enter a valid “from” email address');
      if (cfg.appUrl && !/^https?:\/\/[^\s]+$/i.test(cfg.appUrl)) throw new Error('App link must start with http:// or https://');
      file.write(cfg);
      return this.publicConfig();
    },
    clear() { file.remove(); },

    async send({ to, subject, text, html, attachments }) {
      const cfg = read();
      if (!cfg?.host) throw new Error('Email isn’t set up yet (⚙ menu → Admin → Email)');
      if (!validEmail(to)) throw new Error('Invalid email address');
      try {
        await transport(cfg).sendMail({
          from: { name: cfg.fromName || 'PeptideTracker', address: cfg.fromAddress },
          to, subject, text, html, ...(attachments && { attachments }),
        });
      } catch (e) {
        // Turn the common Gmail failure into something actionable.
        if (/535|Username and Password not accepted|Invalid login/i.test(e.message)) {
          throw new Error('Gmail rejected the login. Use a Gmail App Password, not your normal password.');
        }
        throw new Error(`Couldn't send email: ${e.message}`);
      }
    },
    appUrl: () => read()?.appUrl || '',
  };
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ greeting, lines, rows = [], button, footer }) {
  const text = [greeting, '', ...lines, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(button ? ['', `${button.label}: ${button.url}`] : []), '', footer].join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:480px">
  <p>${escHtml(greeting)}</p>
  ${lines.map(l => `<p>${escHtml(l)}</p>`).join('')}
  ${rows.length ? `<table style="border-collapse:collapse;margin:12px 0;background:#f4f3ef;border-radius:10px">${rows.map(([k, v]) => `<tr><td style="padding:8px 14px;color:#555">${escHtml(k)}</td><td style="padding:8px 14px;font-weight:700;font-family:ui-monospace,Menlo,monospace">${escHtml(v)}</td></tr>`).join('')}</table>` : ''}
  ${button ? `<p><a href="${escHtml(button.url)}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600">${escHtml(button.label)}</a></p>` : ''}
  <p style="color:#555">${escHtml(footer)}</p>
</div>`;
  return { text, html };
}

// Username + temporary password (kind 'invite' or 'reset'), set by the admin.
export function accountEmail({ kind, user, password, appUrl, by, name }) {
  const link = appUrl ? `${appUrl}/?u=${encodeURIComponent(user)}` : '';
  const subject = kind === 'invite' ? 'Your PeptideTracker account' : 'Your PeptideTracker password was reset';
  const intro = kind === 'invite' ? `${by} set up a PeptideTracker account for you.` : `${by} reset your PeptideTracker password.`;
  return {
    subject,
    ...layout({
      greeting: `Hi ${name || user},`,
      lines: [intro, ...(link ? [`Sign in here: ${link}`] : ['Open the PeptideTracker app to sign in.'])],
      rows: [['Username', user], ['Temporary password', password]],
      button: link ? { label: 'Sign in to PeptideTracker', url: link } : null,
      footer: 'You’ll be asked to choose your own password when you sign in.',
    }),
  };
}

// Invite link: they pick their own username, name and password.
export function inviteEmail({ link, by }) {
  return {
    subject: `${by} invited you to PeptideTracker`,
    ...layout({
      greeting: 'Hi,',
      lines: [`${by} invited you to PeptideTracker, a private place to track your peptides, shots and progress.`, `Set up your account here: ${link}`],
      button: { label: 'Set up my account', url: link },
      footer: 'This link works once and expires in 7 days. If you weren’t expecting it, you can ignore this email.',
    }),
  };
}

// Forgot password.
export function resetLinkEmail({ link, user, name }) {
  return {
    subject: 'Reset your PeptideTracker password',
    ...layout({
      greeting: `Hi ${name || user},`,
      lines: ['Someone (hopefully you) asked to reset your PeptideTracker password.', `Choose a new one here: ${link}`],
      rows: [['Username', user]],
      button: { label: 'Choose a new password', url: link },
      footer: 'This link works once and expires in 1 hour. If you didn’t ask for this, ignore this email — your password won’t change.',
    }),
  };
}
