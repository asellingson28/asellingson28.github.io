import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  SITE_DOMAIN,
  stripMarkdown,
  createTransporter,
  maskEmail,
  renderBlogPostEmail,
  wrapEmailPreviewDocument,
  coverRawUrl,
  coverDataUri,
  buildUnsubscribeUrl,
  buildBlogPostMailOptions,
  logoDataUri,
} from './lib/mail-theme.mjs';

const BLOG_DIR = 'src/content/blog';
const DEFAULT_SITE_URL = `https://${SITE_DOMAIN}`;
const ZERO_SHA = /^0+$/;

const args = process.argv.slice(2);
const dryRun = takeFlag('--dry-run');
const all = takeFlag('--all');
const previewMode = takeFlag('--preview');
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

function toPost(file, data) {
  const slug = path.basename(file, '.md');
  const siteUrl = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');
  return {
    file,
    slug,
    url: `${siteUrl}/blog/${slug}/`,
    title: String(data.title),
    description: data.description ? String(data.description) : '',
    date: data.date ? String(data.date) : '',
    cover: data.cover ? String(data.cover) : '',
    coverCaption: data.coverCaption ? String(data.coverCaption) : '',
  };
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

  return toPost(change.currentPath, current.data);
}

function splitRecipients(value) {
  return String(value ?? '')
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function coverAlt(post) {
  return post.coverCaption ? stripMarkdown(post.coverCaption) : `Cover art for ${stripMarkdown(post.title)}`;
}

function renderPostEmailHtml(post, preview, unsubscribe, coverUrl, logoSrc) {
  return renderBlogPostEmail({
    title: post.title,
    url: post.url,
    preview,
    unsubscribe,
    coverUrl,
    coverAlt: coverUrl ? coverAlt(post) : undefined,
    coverCaption: coverUrl ? post.coverCaption : undefined,
    logoSrc,
  });
}

// One recipient per send (rather than one bcc'd blast) so each subscriber
// gets their own buildUnsubscribeUrl() token — a shared link can't identify
// which address to remove. Message construction (subject/text/html/headers)
// is shared with dev-edit-blog.mjs's /send-test-email via
// buildBlogPostMailOptions so the two can't drift apart.
function mailForPost(post, recipient) {
  const unsubscribe = buildUnsubscribeUrl(recipient);
  const preview = post.description || `A new post is live on ${new URL(post.url).hostname}.`;
  const coverUrl = coverRawUrl(post.file, post.cover);

  return buildBlogPostMailOptions({
    title: post.title,
    url: post.url,
    preview,
    unsubscribe,
    coverUrl,
    coverAlt: coverUrl ? coverAlt(post) : undefined,
    coverCaption: coverUrl ? post.coverCaption : undefined,
    to: recipient,
    from: process.env.MAIL_FROM,
    replyTo: process.env.MAIL_REPLY_TO || undefined,
  });
}

if (previewMode) {
  if (explicitFiles.length === 0) {
    console.error('Usage: npm run notify:blog -- --preview <file.md> [file...]');
    process.exit(1);
  }

  const outDir = '.cache';
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of explicitFiles) {
    const parsed = parseFrontmatter(readCurrent(file));
    if (!parsed?.data?.title) {
      console.error(`Skipping ${file}: no title in frontmatter.`);
      continue;
    }

    // Deliberately skips isPublishable() — previewing a draft is the point.
    const post = toPost(file, parsed.data);
    const unsubscribe = buildUnsubscribeUrl('preview@example.com');
    const preview = post.description || `A new post is live on ${new URL(post.url).hostname}.`;
    const coverUrl = coverDataUri(post.file, post.cover);
    const html = renderPostEmailHtml(post, preview, unsubscribe, coverUrl, logoDataUri());
    const doc = wrapEmailPreviewDocument(html, { title: `Email preview: ${stripMarkdown(post.title)}` });

    const outFile = path.join(outDir, `email-preview-${post.slug}.html`);
    fs.writeFileSync(outFile, doc);
    console.log(`Wrote preview: ${outFile}`);
    try {
      execFileSync('open', [outFile]);
    } catch {
      console.log(`(Could not auto-open; open ${outFile} manually.)`);
    }
  }
  process.exit(0);
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

// Recipients are sent to concurrently (bounded, since a huge subscriber list
// sent one-at-a-time would serialize an SMTP round-trip per address) and each
// send is isolated in its own try/catch — one recipient throwing (a timeout,
// a connection drop) must not abort the rest of the list the way an
// exception escaping a plain for-loop would. Mirrors the per-recipient
// try/catch in send-subscription-confirmations.mjs's run().
const SEND_CONCURRENCY = 5;

async function sendPostToRecipients(post, recipients) {
  const accepted = [];
  const rejected = [];
  const failed = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < recipients.length) {
      const recipient = recipients[nextIndex++];
      try {
        const info = await transporter.sendMail(mailForPost(post, recipient));
        if (info.rejected?.filter(Boolean).length > 0) rejected.push(recipient);
        else accepted.push(recipient);
      } catch (err) {
        failed.push(recipient);
        console.error(`Failed to send ${post.slug} to ${maskEmail(recipient)}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, recipients.length) }, worker));
  return { accepted, rejected, failed };
}

let anyRejected = false;

for (const post of posts) {
  const { accepted, rejected, failed } = await sendPostToRecipients(post, subscribers);

  console.log(
    `Sent email for ${post.slug}: ${accepted.length} accepted (${accepted.map(maskEmail).join(', ')}), ${rejected.length} rejected, ${failed.length} failed to send.`
  );

  if (rejected.length > 0 || failed.length > 0) {
    anyRejected = true;
    if (rejected.length > 0) {
      console.error(`SMTP server rejected these address(es) for ${post.slug}: ${rejected.map(maskEmail).join(', ')}`);
    }
    if (failed.length > 0) {
      console.error(`Sending failed outright for these address(es) for ${post.slug}: ${failed.map(maskEmail).join(', ')}`);
    }
  }
}

if (anyRejected) {
  console.error(
    'One or more subscriber addresses were rejected or failed to send. The job succeeded for at least one recipient, so this did not fail the workflow on its own — check the addresses above.'
  );
  process.exit(1);
}
