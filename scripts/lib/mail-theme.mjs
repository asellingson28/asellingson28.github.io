import nodemailer from 'nodemailer';

// Mirrors the site's default "royal" theme (src/styles/global.css root tokens):
// dark ground, hairline gold rule, steel-blue accent, monospace annotations.
// Email clients don't load the site's web fonts or CSS custom properties, so
// colors are hardcoded and fonts fall back to system serif/sans/mono stacks.
export const EMAIL_THEME = {
  bg: '#0a0d12',
  card: '#10141c',
  line: '#232b38',
  gold: '#c9a227',
  goldBright: '#e0bc4a',
  blueBright: '#7fb0e0',
  text: '#e4e1d8',
  textDim: '#8a8f98',
  textFaint: '#565c68',
  fontDisplay: "Georgia, 'Times New Roman', serif",
  fontBody: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontMono: "'Courier New', Courier, monospace",
};

export function stripTags(value) {
  return value.replace(/<[^>]*>/g, '').trim();
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char];
  });
}

export function createTransporter() {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required mail env var(s): ${missing.join(', ')}`);
  }

  const host = process.env.SMTP_HOST.trim();
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error(
      'SMTP_HOST should be only a hostname like "smtp.gmail.com". Do not include "SMTP_HOST=", quotes, spaces, slashes, or backslashes in the GitHub secret value.'
    );
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('SMTP_PORT should be a number like 587 or 465.');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export function maskEmail(value) {
  const address = addressFromFormatted(value);
  const [user, domain] = address.split('@');
  if (!domain) return `${address.slice(0, 2)}***`;
  const maskedUser = user.length <= 2 ? `${user[0] ?? ''}*` : `${user.slice(0, 2)}${'*'.repeat(user.length - 2)}`;
  return `${maskedUser}@${domain}`;
}

export function addressFromFormatted(value) {
  const match = String(value ?? '').match(/<([^>]+)>/);
  return (match?.[1] ?? value ?? '').trim();
}

// Shared "royal" card shell used by both the new-post and confirm-subscription
// emails: hairline gold->line->blue rule, mono eyebrow, serif title, optional
// body copy, a bordered CTA button, hairline divider, mono footer.
export function renderEmailCard({ eyebrow, title, bodyHtml, cta, footerHtml }) {
  const t = EMAIL_THEME;

  const bodyRow = bodyHtml
    ? `<tr><td style="padding:0 40px 28px;">${bodyHtml}</td></tr>`
    : '';

  const ctaRow = cta
    ? `<tr><td style="padding:0 40px 36px;">
<a href="${escapeHtml(cta.href)}" style="display:inline-block;padding:12px 24px;border:1px solid ${t.gold};font-family:${t.fontBody};font-size:14px;font-weight:600;letter-spacing:0.02em;color:${t.goldBright};text-decoration:none;">${escapeHtml(cta.label)}</a>
</td></tr>`
    : '';

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:40px 16px;">`,
    `<tr><td align="center">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${t.card};border:1px solid ${t.line};">`,
    // hairline title-block rule, gold -> line -> blue, echoing the site nav
    `<tr><td style="height:3px;line-height:3px;font-size:0;background:${t.gold};background-image:linear-gradient(90deg, ${t.gold} 0%, ${t.line} 50%, ${t.blueBright} 100%);">&nbsp;</td></tr>`,
    `<tr><td style="padding:36px 40px 4px;">`,
    `<span style="font-family:${t.fontMono};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${t.textFaint};">${escapeHtml(eyebrow)}</span>`,
    `</td></tr>`,
    `<tr><td style="padding:6px 40px 18px;">`,
    `<h1 style="margin:0;font-family:${t.fontDisplay};font-weight:500;font-size:26px;line-height:1.3;color:${t.text};">${escapeHtml(title)}</h1>`,
    `</td></tr>`,
    bodyRow,
    ctaRow,
    `<tr><td style="padding:0 40px;"><div style="border-top:1px solid ${t.line};font-size:0;line-height:0;">&nbsp;</div></td></tr>`,
    `<tr><td style="padding:20px 40px 32px;">`,
    `<p style="margin:0;font-family:${t.fontMono};font-size:11px;letter-spacing:0.03em;color:${t.textFaint};">${footerHtml}</p>`,
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ]
    .filter(Boolean)
    .join('\n');
}
