import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { renderInlineMarkdown, stripMarkdown } from '../../src/lib/inline-markdown.mjs';

export { stripMarkdown };

// The site's public domain, as referenced in outbound email copy.
export const SITE_DOMAIN = 'aselling.us';

// Blog post covers live in src/content/blog/ and are only reachable through
// Astro's content-image pipeline (hashed /_astro/* output) once built —
// scripts here run outside that pipeline and can't predict the hash. The
// repo is public, so raw.githubusercontent.com serves the original file
// directly and needs no build step.
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/asellingson28/asellingson28.github.io/main';

const IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

// Resolves a post's `cover: ./foo.jpg` frontmatter value (relative to the
// markdown file) to a public URL real subscribers' email clients can fetch.
export function coverRawUrl(mdFile, coverValue) {
  if (!coverValue) return undefined;
  const dir = path.posix.dirname(mdFile.split(path.sep).join('/'));
  const repoPath = path.posix.normalize(path.posix.join(dir, coverValue));
  return `${GITHUB_RAW_BASE}/${repoPath}`;
}

// Same resolution, but reads the file straight off local disk and embeds it
// as a data: URI — for preview only. Unlike coverRawUrl, this shows the
// cover as it currently sits on disk even if it's never been committed or
// pushed, which is the point of a *local* preview.
export function coverDataUri(mdFile, coverValue) {
  if (!coverValue) return undefined;
  const dir = path.dirname(mdFile);
  const absPath = path.join(dir, coverValue);
  const mime = IMAGE_MIME_TYPES[path.extname(absPath).toLowerCase()];
  if (!mime || !fs.existsSync(absPath)) return undefined;
  return `data:${mime};base64,${fs.readFileSync(absPath).toString('base64')}`;
}

// Mirrors the site's "odyssey" theme, the default (src/styles/global.css :root
// tokens): dark ground, hairline bronze rule, misty blue-teal accent, monospace annotations.
// Email clients don't load the site's web fonts or CSS custom properties, so
// colors are hardcoded and fonts fall back to system serif/sans/mono stacks.
export const EMAIL_THEME = {
  bg: '#0a1119',
  card: '#101b26',
  line: '#25323f',
  gold: '#a9814a',
  goldBright: '#d1a562',
  blueBright: '#7eb0c4',
  text: '#e6e0d2',
  textDim: '#8b95a1',
  textFaint: '#566270',
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

// HMAC-SHA256 over a domain-separated "unsubscribe:<email>" payload, hex
// encoded. Derived, not stored — the Worker (worker/src/index.js) verifies
// this independently via Web Crypto against the same UNSUBSCRIBE_SECRET, so
// there's no per-subscriber token in KV to keep in sync. Must be called with
// an already-normalized (trimmed, lowercased) email on both the signing and
// verifying side, or tokens won't match.
export function unsubscribeToken(email, secret) {
  return crypto.createHmac('sha256', secret).update(`unsubscribe:${email}`).digest('hex');
}

// Builds a per-recipient one-click unsubscribe link against the Worker
// (worker/src/index.js's /unsubscribe, verified via verifyUnsubscribeToken())
// when both WORKER_URL and UNSUBSCRIBE_SECRET are configured. Falls back to a
// generic mailto: (or an explicit override) otherwise — e.g. a local run
// without the Worker secret set — so an email always has *some* unsubscribe
// path, just not a self-service one-click link. Shared by
// notify-blog-subscribers.mjs (real sends) and dev-edit-blog.mjs (the "send
// test email" button) so both build the link the same way.
// Normalizes (trims, lowercases) the email itself before signing/embedding it
// — callers (e.g. the manually-managed MAIL_SUBSCRIBERS list, which is only
// comma-split and trimmed, never lowercased) can't be trusted to hand this a
// normalized address, and the Worker always lowercases the `email` query
// param before verifying, so an un-normalized token here would never verify.
export function buildUnsubscribeUrl(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (workerUrl && secret) {
    const url = new URL('/unsubscribe', workerUrl);
    url.searchParams.set('email', normalized);
    url.searchParams.set('token', unsubscribeToken(normalized, secret));
    return url.toString();
  }
  return (
    process.env.MAIL_UNSUBSCRIBE ||
    process.env.UNSUBSCRIBE_URL ||
    `mailto:${addressFromFormatted(process.env.MAIL_FROM)}?subject=unsubscribe`
  );
}

// Shared "odyssey" card shell used by both the new-post and confirm-subscription
// emails: hairline gold->line->blue rule, mono eyebrow, serif title, optional
// body copy, a bordered CTA button, hairline divider, mono footer.
// title is escaped as plain text by default; pass titleHtml instead (already
// rendered/safe markup, e.g. via renderInlineMarkdown) to allow inline
// markdown formatting like **bold** or [links](url) in the heading.
export function renderEmailCard({
  eyebrow,
  title,
  titleHtml,
  coverUrl,
  coverAlt,
  coverCaptionHtml,
  bodyHtml,
  cta,
  footerHtml,
}) {
  const t = EMAIL_THEME;
  const titleMarkup = titleHtml ?? escapeHtml(title);

  const coverRow = coverUrl
    ? `<tr><td style="padding:0 40px 24px;">
<img data-role="cover" src="${escapeHtml(coverUrl)}" alt="${escapeHtml(coverAlt ?? '')}" width="480" style="display:block;width:100%;max-width:480px;height:auto;border:1px solid ${t.line};" />
${coverCaptionHtml ? `<p data-role="cover-caption" style="margin:6px 0 0;font-family:${t.fontMono};font-size:11px;letter-spacing:0.04em;color:${t.textFaint};">${coverCaptionHtml}</p>` : ''}
</td></tr>`
    : '';

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
    `<h1 style="margin:0;font-family:${t.fontDisplay};font-weight:500;font-size:26px;line-height:1.3;color:${t.text};">${titleMarkup}</h1>`,
    `</td></tr>`,
    coverRow,
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

// The "new post" notification email — shared by the real send
// (scripts/notify-blog-subscribers.mjs) and the dev-only editor preview
// (scripts/dev-edit-blog.mjs) so the preview can't drift from what
// subscribers actually get.
export function renderBlogPostEmail({ title, url, preview, unsubscribe, coverUrl, coverAlt, coverCaption }) {
  return renderEmailCard({
    eyebrow: '03 / writing · new post',
    titleHtml: renderInlineMarkdown(title),
    coverUrl,
    coverAlt,
    coverCaptionHtml: coverUrl && coverCaption ? renderInlineMarkdown(coverCaption) : undefined,
    bodyHtml: preview
      ? `<p style="margin:0;font-family:${EMAIL_THEME.fontBody};font-size:15px;line-height:1.6;color:${EMAIL_THEME.textDim};">${renderInlineMarkdown(stripTags(preview))}</p>`
      : '',
    cta: { href: url, label: 'Read the post →' },
    footerHtml: `sent to subscribers of ${SITE_DOMAIN} &middot; <a href="${escapeHtml(unsubscribe)}" style="color:${EMAIL_THEME.textDim};">unsubscribe</a>`,
  });
}

// Builds the full nodemailer message (subject, html via renderBlogPostEmail,
// plain-text fallback, List-Unsubscribe headers) for a "new post" email.
// Shared by notify-blog-subscribers.mjs (real sends to subscribers) and
// dev-edit-blog.mjs's /send-test-email (a real send to one address typed
// into the post editor) so the test email can't drift from what a real
// notification looks like — a `subjectPrefix` (e.g. "[TEST] ") is the only
// place they intentionally differ.
export function buildBlogPostMailOptions({
  title,
  url,
  preview,
  unsubscribe,
  coverUrl,
  coverAlt,
  coverCaption,
  to,
  from,
  replyTo,
  subjectPrefix = '',
  attachments,
}) {
  return {
    from,
    to,
    replyTo,
    subject: `${subjectPrefix}New post: ${stripMarkdown(title)}`,
    text: [
      stripMarkdown(title),
      '',
      stripMarkdown(stripTags(preview)),
      '',
      `Read it here: ${url}`,
      '',
      `Unsubscribe: ${unsubscribe}`,
    ].join('\n'),
    html: renderBlogPostEmail({ title, url, preview, unsubscribe, coverUrl, coverAlt, coverCaption }),
    attachments,
    list: { unsubscribe },
    headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

// Wraps a rendered email fragment (from renderEmailCard/renderBlogPostEmail)
// in a minimal document with an explicit charset. The fragment alone has no
// <head>, so opening it directly (a local .html file, or a Blob without a
// charset param) leaves the browser to guess the encoding — and it reliably
// guesses wrong for non-ASCII characters (em dashes, curly quotes, accents),
// garbling them. Real sent mail doesn't need this: nodemailer sets the
// charset in the MIME headers itself. This is preview-only.
export function wrapEmailPreviewDocument(bodyHtml, { title = 'Email preview' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;">
${bodyHtml}
</body>
</html>`;
}
