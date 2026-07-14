import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  EMAIL_THEME,
  escapeHtml,
  stripTags,
  createTransporter,
  maskEmail,
  addressFromFormatted,
  renderEmailCard,
} from './lib/mail-theme.mjs';

const BLOG_DIR = 'src/content/blog';
const DEFAULT_SITE_URL = 'https://aselling.us';
const ZERO_SHA = /^0+$/;

const args = process.argv.slice(2);
const dryRun = takeFlag('--dry-run');
const all = takeFlag('--all');
const since = takeOption('--since');
const head = takeOption('--head') ?? 'HEAD';
const explicitFiles = args.filter((arg) => !arg.startsWith('-'));

function takeFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function takeOption(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

function git(argsForGit, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', argsForGit, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    });
  } catch (err) {
    if (allowFailure) return '';
    throw err;
  }
}

function changedBlogFiles(baseRef, headRef) {
  if (!baseRef || ZERO_SHA.test(baseRef)) return [];

  const output = git(
    ['diff', '--name-status', '--find-renames', baseRef, headRef, '--', BLOG_DIR],
    { allowFailure: true }
  ).trim();
  if (!output) return [];

  return output
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .flatMap(([status, firstPath, secondPath]) => {
      const currentPath = secondPath ?? firstPath;
      const previousPath = secondPath ? firstPath : firstPath;
      if (status?.startsWith('D') || !currentPath?.endsWith('.md')) return [];
      return [{ status, previousPath, currentPath }];
    });
}

function allBlogFiles() {
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs
    .readdirSync(BLOG_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ status: 'A', currentPath: path.join(BLOG_DIR, name) }));
}

function explicitBlogFiles(files) {
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ status: 'A', currentPath: file }));
}

function readCurrent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readAtRef(ref, file) {
  if (!ref || !file) return undefined;
  return git(['show', `${ref}:${file}`], { allowFailure: true }) || undefined;
}

function parseValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(raw) {
  if (!raw) return undefined;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    data[key] = parseValue(value);
  }

  return { data, body: match[2].trim() };
}

function isPublishable(post) {
  if (!post?.data?.title) return false;
  if (post.data.draft === true) return false;
  if (post.data.notify === false || post.data.email === false) return false;
  return true;
}

function postFromChange(change) {
  const current = parseFrontmatter(readCurrent(change.currentPath));
  const previous =
    change.previousPath && since
      ? parseFrontmatter(readAtRef(since, change.previousPath))
      : undefined;

  if (!isPublishable(current)) return undefined;

  const wasPublishable = isPublishable(previous);
  const shouldSend = all || explicitFiles.length > 0 || !wasPublishable;
  if (!shouldSend) return undefined;

  const slug = path.basename(change.currentPath, '.md');
  const siteUrl = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');
  return {
    file: change.currentPath,
    slug,
    url: `${siteUrl}/blog/${slug}/`,
    title: String(current.data.title),
    description: current.data.description ? String(current.data.description) : '',
    date: current.data.date ? String(current.data.date) : '',
  };
}

function splitRecipients(value) {
  return String(value ?? '')
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unsubscribeUrl(from) {
  return (
    process.env.MAIL_UNSUBSCRIBE ||
    process.env.UNSUBSCRIBE_URL ||
    `mailto:${addressFromFormatted(from)}?subject=unsubscribe`
  );
}

// Self-serve signups (via the Cloudflare Worker subscribe form) are additive
// to the manually-managed MAIL_SUBSCRIBERS secret. If the Worker is
// unreachable or unconfigured, fall back to just the manual list rather than
// failing the whole notify job over a non-essential dependency.
async function fetchWorkerSubscribers() {
  const workerUrl = process.env.WORKER_URL;
  const syncSecret = process.env.SYNC_SECRET;
  if (!workerUrl || !syncSecret) return [];

  try {
    const res = await fetch(new URL('/subscribers', workerUrl), {
      headers: { Authorization: `Bearer ${syncSecret}` },
    });
    if (!res.ok) {
      console.error(`Worker /subscribers returned ${res.status}; continuing with MAIL_SUBSCRIBERS only.`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.subscribers) ? data.subscribers : [];
  } catch (err) {
    console.error(`Could not reach Worker /subscribers (${err.message}); continuing with MAIL_SUBSCRIBERS only.`);
    return [];
  }
}

function renderPostEmailHtml(post, preview, unsubscribe) {
  return renderEmailCard({
    eyebrow: '03 / writing · new post',
    title: post.title,
    bodyHtml: preview
      ? `<p style="margin:0;font-family:${EMAIL_THEME.fontBody};font-size:15px;line-height:1.6;color:${EMAIL_THEME.textDim};">${escapeHtml(stripTags(preview))}</p>`
      : '',
    cta: { href: post.url, label: 'Read the post →' },
    footerHtml: `sent to subscribers of asellingson28.github.io &middot; <a href="${escapeHtml(unsubscribe)}" style="color:${EMAIL_THEME.textDim};">unsubscribe</a>`,
  });
}

function mailForPost(post, subscribers) {
  const from = process.env.MAIL_FROM;
  const to = process.env.MAIL_TO || from;
  const replyTo = process.env.MAIL_REPLY_TO || undefined;
  const unsubscribe = unsubscribeUrl(from);
  const preview = post.description || `A new post is live on ${new URL(post.url).hostname}.`;

  return {
    from,
    to,
    bcc: subscribers,
    replyTo,
    subject: `New post: ${post.title}`,
    text: [
      post.title,
      '',
      stripTags(preview),
      '',
      `Read it here: ${post.url}`,
      '',
      `Unsubscribe: ${unsubscribe}`,
    ].join('\n'),
    html: renderPostEmailHtml(post, preview, unsubscribe),
    list: {
      unsubscribe,
    },
    headers: {
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

const changes =
  explicitFiles.length > 0
    ? explicitBlogFiles(explicitFiles)
    : all
      ? allBlogFiles()
      : changedBlogFiles(since, head);

const posts = changes.map(postFromChange).filter(Boolean);

if (posts.length === 0) {
  console.log('No newly published blog posts to email.');
  process.exit(0);
}

console.log(`Found ${posts.length} blog post(s) to email:`);
for (const post of posts) {
  console.log(`- ${post.title} (${post.file})`);
}

const manualSubscribers = splitRecipients(process.env.MAIL_SUBSCRIBERS);
const workerSubscribers = await fetchWorkerSubscribers();
const subscribers = [...new Set([...manualSubscribers, ...workerSubscribers])];

console.log(
  `Subscribers (${subscribers.length}): ${subscribers.length ? subscribers.map(maskEmail).join(', ') : '(none)'} ` +
    `[${manualSubscribers.length} manual via MAIL_SUBSCRIBERS, ${workerSubscribers.length} self-serve via Worker]`
);

if (dryRun) {
  console.log(`Dry run: would email ${subscribers.length} subscriber(s).`);
  process.exit(0);
}

if (subscribers.length === 0) {
  console.log('No subscribers (MAIL_SUBSCRIBERS and the Worker subscriber list are both empty), so no email will be sent.');
  process.exit(0);
}

const transporter = createTransporter();
await transporter.verify();

let anyRejected = false;

for (const post of posts) {
  const info = await transporter.sendMail(mailForPost(post, subscribers));
  const rejected = info.rejected?.filter(Boolean) ?? [];
  const accepted = info.accepted?.filter(Boolean) ?? [];

  console.log(
    `Sent email for ${post.slug}: ${accepted.length} accepted (${accepted.map(maskEmail).join(', ')}), ${rejected.length} rejected. SMTP response: ${info.response}`
  );

  if (rejected.length > 0) {
    anyRejected = true;
    console.error(`SMTP server rejected these address(es) for ${post.slug}: ${rejected.map(maskEmail).join(', ')}`);
  }
}

if (anyRejected) {
  console.error(
    'One or more subscriber addresses were rejected by the SMTP server. The job succeeded for at least one recipient, so this did not fail the workflow on its own — check the addresses above.'
  );
  process.exit(1);
}
