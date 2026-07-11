import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

const BLOG_DIR = 'src/content/blog';
const DEFAULT_SITE_URL = 'https://asellingson28.github.io';
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

function stripTags(value) {
  return value.replace(/<[^>]*>/g, '').trim();
}

function escapeHtml(value) {
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

function addressFromFormatted(value) {
  const match = String(value ?? '').match(/<([^>]+)>/);
  return (match?.[1] ?? value ?? '').trim();
}

function unsubscribeUrl(from) {
  return (
    process.env.MAIL_UNSUBSCRIBE ||
    process.env.UNSUBSCRIBE_URL ||
    `mailto:${addressFromFormatted(from)}?subject=unsubscribe`
  );
}

function createTransporter() {
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
    html: [
      `<h1>${escapeHtml(post.title)}</h1>`,
      preview ? `<p>${escapeHtml(stripTags(preview))}</p>` : '',
      `<p><a href="${escapeHtml(post.url)}">Read the post</a></p>`,
      `<p style="font-size:12px;color:#666">To unsubscribe, use <a href="${escapeHtml(unsubscribe)}">this link</a>.</p>`,
    ].join('\n'),
    list: {
      unsubscribe,
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
const subscribers = splitRecipients(process.env.MAIL_SUBSCRIBERS);

if (posts.length === 0) {
  console.log('No newly published blog posts to email.');
  process.exit(0);
}

console.log(`Found ${posts.length} blog post(s) to email:`);
for (const post of posts) {
  console.log(`- ${post.title} (${post.file})`);
}

if (dryRun) {
  console.log(`Dry run: would email ${subscribers.length} subscriber(s).`);
  process.exit(0);
}

if (subscribers.length === 0) {
  console.log('MAIL_SUBSCRIBERS is empty, so no email will be sent.');
  process.exit(0);
}

const transporter = createTransporter();
await transporter.verify();

for (const post of posts) {
  await transporter.sendMail(mailForPost(post, subscribers));
  console.log(`Sent email for ${post.slug} to ${subscribers.length} subscriber(s).`);
}
