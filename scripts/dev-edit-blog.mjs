// Dev-only endpoints behind the blog editor on /blog (mounted at /__edit-blog
// by scripts/dev-add-place.mjs — never part of the built site).
// POST /__edit-blog/save { slug?, title, date, description?, tags?, draft?, coverCaption?, body }
//   with slug: rewrites the managed frontmatter fields of an existing post,
//   leaving anything else in the frontmatter untouched, and replaces the body
//   without slug: creates src/content/blog/<slug-from-title>.md
// POST /__edit-blog/image?slug=<slug>&name=<filename>  (raw image body)
//   saves the post's cover photo as <slug>-cover.<ext> next to the .md file
//   and sets its `cover:` frontmatter line
// POST /__edit-blog/content-image?slug=<slug>&name=<filename>  (raw image body)
//   saves an inline body photo as <slug>-<name>.<ext> next to the .md file
//   (never overwrites — numbered if that name is taken) and returns its path
//   for the client to insert as `![](path "optional caption")`; Astro optimizes
//   any relative image path referenced from a content-collection markdown body
//   on its own, same as the cover image, so no frontmatter/schema changes are
//   needed — the optional "caption" (markdown's image title syntax) is turned
//   into a <figcaption> by rehype-image-captions.mjs
// POST /__edit-blog/preview { title, description?, tags?, coverCaption?, body }
//   renders the not-yet-saved fields through the same markdown pipeline the
//   real site uses (title/description/tags/coverCaption via inline-markdown.mjs,
//   body via @astrojs/markdown-remark + the site's remark plugins) so the
//   preview can't silently drift from what the built post will look like
// POST /__edit-blog/send-test-email { slug?, title, description?, coverCaption?, to }
//   renders the not-yet-saved title/description through the same "new post"
//   notification email scripts/notify-blog-subscribers.mjs sends (via
//   scripts/lib/mail-theme.mjs's buildBlogPostMailOptions) and actually sends
//   it via SMTP to `to`, so the "send test email" button can't drift from
//   what subscribers actually get and lets you eyeball it in a real inbox.
//   Requires the same SMTP_*/MAIL_FROM env vars as
//   notify-blog-subscribers.mjs to be set before `npm run dev`; the
//   unsubscribe link is a real, working one (buildUnsubscribeUrl(to)) when
//   WORKER_URL/UNSUBSCRIBE_SECRET are also set, so that flow is testable too.
//   The subscriber list is never touched. If the post already has a saved
//   cover image on disk, it's attached as a cid: inline image (a real MIME
//   attachment referenced via <img src="cid:...">, not a data: URI —
//   real inboxes like Gmail strip data: URIs from received mail as a
//   security measure, so that only ever worked for the in-browser preview,
//   never for an actually-sent message); a cover just picked in the form but
//   not yet uploaded can't be included — there's no way to email a
//   browser-only blob: URL — save the post first. Rejects any request whose
//   TCP peer isn't loopback (see isLocalRequest) — this sends real mail
//   through real SMTP credentials, so it must not work if the dev server is
//   ever exposed off localhost (e.g. `astro dev --host`).
// NOTE: loaded once at dev-server startup — restart `npm run dev` after edits.
import fs from 'node:fs';
import path from 'node:path';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkFootnoteTitles from './remark-footnote-titles.mjs';
import remarkFlexibleMarkers from 'remark-flexible-markers';
import rehypeImageCaptions from './rehype-image-captions.mjs';
import { renderInlineMarkdown } from '../src/lib/inline-markdown.mjs';
import {
  SITE_DOMAIN,
  createTransporter,
  buildUnsubscribeUrl,
  buildBlogPostMailOptions,
  stripMarkdown,
  logoAttachment,
  LOGO_CID,
} from './lib/mail-theme.mjs';

const TEST_EMAIL_COVER_CID = 'test-email-cover';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// /send-test-email here and the confirmation-email test endpoint in
// dev-add-place.mjs both send real mail through the site owner's SMTP
// credentials to an address the client supplies — if `npm run dev --host`
// ever exposes the dev server to the LAN, that would otherwise let anyone
// reachable use it as an open relay. req.socket.remoteAddress reflects the
// actual TCP peer, so unlike a Host/Origin header it can't be spoofed by a
// forged request.
export function isLocalRequest(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// created lazily (it's not free) and reused across preview requests
let processorPromise;
function getMarkdownProcessor() {
  if (!processorPromise)
    processorPromise = createMarkdownProcessor({
      remarkPlugins: [remarkFootnoteTitles, [remarkFlexibleMarkers, { actionForEmptyContent: 'keep' }]],
      rehypePlugins: [rehypeImageCaptions],
    });
  return processorPromise;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'post';

// replace/insert/remove a `key: value` frontmatter line in place; a key's
// value may continue on indented lines (block-style lists) — the whole span
// is replaced, and value === undefined removes the field entirely
function setLine(lines, key, value) {
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx === -1) {
    if (value !== undefined) lines.push(`${key}: ${value}`);
    return;
  }
  let span = 1;
  while (idx + span < lines.length && /^\s/.test(lines[idx + span])) span++;
  lines.splice(idx, span, ...(value === undefined ? [] : [`${key}: ${value}`]));
}

export function blogEditHandler({ dir = path.resolve('src/content/blog') } = {}) {
  return (req, res) => {
    const reply = (code, payload) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/image') {
      const slug = slugify(String(url.searchParams.get('slug') ?? ''));
      const original = path.basename(String(url.searchParams.get('name') ?? 'cover'));
      const ext = path.extname(original).toLowerCase();
      if (!IMAGE_EXTS.has(ext))
        return reply(400, { error: `unsupported image type "${ext || 'none'}" (HEIC? convert to jpg first)` });
      const mdFile = path.join(dir, `${slug}.md`);
      if (!fs.existsSync(mdFile)) return reply(400, { error: `no post file for slug "${slug}"` });

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // one cover per post: replace any previous one, whatever its extension
        for (const e of IMAGE_EXTS) {
          const old = path.join(dir, `${slug}-cover${e}`);
          if (e !== ext && fs.existsSync(old)) fs.unlinkSync(old);
        }
        const file = path.join(dir, `${slug}-cover${ext}`);
        fs.writeFileSync(file, Buffer.concat(chunks));

        const m = fs.readFileSync(mdFile, 'utf8').match(FM_RE);
        if (!m) return reply(400, { error: `${slug}.md has no frontmatter` });
        const lines = m[1].split(/\r?\n/);
        setLine(lines, 'cover', `./${slug}-cover${ext}`);
        fs.writeFileSync(mdFile, `---\n${lines.join('\n')}\n---\n${m[2]}`);
        reply(200, { file: path.relative(process.cwd(), file) });
      });
      return;
    }

    if (url.pathname === '/content-image') {
      const slug = slugify(String(url.searchParams.get('slug') ?? ''));
      const original = path.basename(String(url.searchParams.get('name') ?? 'image'));
      const ext = path.extname(original).toLowerCase();
      if (!IMAGE_EXTS.has(ext))
        return reply(400, { error: `unsupported image type "${ext || 'none'}" (HEIC? convert to jpg first)` });
      const mdFile = path.join(dir, `${slug}.md`);
      if (!fs.existsSync(mdFile)) return reply(400, { error: `no post file for slug "${slug}"` });

      const stem = slugify(path.basename(original, path.extname(original))) || 'image';
      let filename = `${slug}-${stem}${ext}`;
      for (let n = 2; fs.existsSync(path.join(dir, filename)); n++) filename = `${slug}-${stem}-${n}${ext}`;

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.writeFileSync(path.join(dir, filename), Buffer.concat(chunks));
        reply(200, { path: `./${filename}` });
      });
      return;
    }

    if (url.pathname === '/preview') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        let p;
        try {
          p = JSON.parse(raw);
        } catch {
          return reply(400, { error: 'invalid JSON' });
        }
        const tags = String(p.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        try {
          const processor = await getMarkdownProcessor();
          const { code: bodyHtml } = await processor.render(String(p.body ?? ''));
          reply(200, {
            titleHtml: renderInlineMarkdown(String(p.title ?? '')),
            descriptionHtml: p.description ? renderInlineMarkdown(String(p.description)) : '',
            tagsHtml: tags.map((t) => renderInlineMarkdown(t)),
            coverCaptionHtml: p.coverCaption ? renderInlineMarkdown(String(p.coverCaption)) : '',
            bodyHtml,
          });
        } catch (err) {
          reply(500, { error: err instanceof Error ? err.message : 'preview failed' });
        }
      });
      return;
    }

    if (url.pathname === '/send-test-email') {
      if (!isLocalRequest(req)) return reply(403, { error: 'only available from localhost' });
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        let p;
        try {
          p = JSON.parse(raw);
        } catch {
          return reply(400, { error: 'invalid JSON' });
        }
        const title = String(p.title ?? '').trim();
        if (!title) return reply(400, { error: 'title is required' });

        const to = String(p.to ?? '').trim().toLowerCase();
        if (!EMAIL_RE.test(to)) return reply(400, { error: 'enter a valid email address' });

        const slug = p.slug ? slugify(String(p.slug)) : slugify(title);
        const description = String(p.description ?? '').trim();
        const coverCaption = String(p.coverCaption ?? '').trim();
        const postUrl = `https://${SITE_DOMAIN}/blog/${slug}/`;
        const preview = description || `A new post is live on ${SITE_DOMAIN}.`;
        const unsubscribe = buildUnsubscribeUrl(to);

        let coverPath, coverUrl;
        for (const ext of IMAGE_EXTS) {
          const candidate = path.join(dir, `${slug}-cover${ext}`);
          if (fs.existsSync(candidate)) {
            coverPath = candidate;
            coverUrl = `cid:${TEST_EMAIL_COVER_CID}`;
            break;
          }
        }
        const coverAlt = coverUrl
          ? coverCaption
            ? stripMarkdown(coverCaption)
            : `Cover art for ${stripMarkdown(title)}`
          : undefined;

        const mailOptions = buildBlogPostMailOptions({
          title,
          url: postUrl,
          preview,
          unsubscribe,
          coverUrl,
          coverAlt,
          coverCaption: coverUrl ? coverCaption : undefined,
          to,
          from: process.env.MAIL_FROM,
          replyTo: process.env.MAIL_REPLY_TO || undefined,
          subjectPrefix: '[TEST] ',
          logoSrc: `cid:${LOGO_CID}`,
          attachments: [
            logoAttachment(),
            ...(coverPath
              ? [{ filename: path.basename(coverPath), path: coverPath, cid: TEST_EMAIL_COVER_CID }]
              : []),
          ],
        });

        try {
          const transporter = createTransporter();
          await transporter.sendMail(mailOptions);
        } catch (err) {
          return reply(500, { error: err instanceof Error ? err.message : 'send failed' });
        }
        reply(200, { ok: true });
      });
      return;
    }

    if (url.pathname !== '/save') return reply(404, { error: 'unknown endpoint' });

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return reply(400, { error: 'invalid JSON' });
      }

      const title = String(p.title ?? '').trim();
      const date = String(p.date ?? '').trim();
      if (!title) return reply(400, { error: 'title is required' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(400, { error: 'date must be YYYY-MM-DD' });
      const description = String(p.description ?? '').trim();
      const caption = String(p.coverCaption ?? '').trim();
      const tags = String(p.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const text = String(p.body ?? '').trim();

      // managed fields; undefined value = remove the line entirely
      // (JSON.stringify output is a valid YAML double-quoted scalar / flow list)
      // `cover` is intentionally not managed here — /image owns that line
      const fields = [
        ['title', JSON.stringify(title)],
        ['date', date], // unquoted so YAML parses it as a date
        ['description', description ? JSON.stringify(description) : undefined],
        ['tags', tags.length ? JSON.stringify(tags) : undefined],
        ['draft', p.draft ? 'true' : undefined],
        ['coverCaption', caption ? JSON.stringify(caption) : undefined],
      ];

      let slug, file;
      if (p.slug) {
        slug = slugify(String(p.slug));
        file = path.join(dir, `${slug}.md`);
        if (!fs.existsSync(file)) return reply(400, { error: `no post file for slug "${slug}"` });

        const m = fs.readFileSync(file, 'utf8').match(FM_RE);
        if (!m) return reply(400, { error: `${slug}.md has no frontmatter` });
        const lines = m[1].split(/\r?\n/);
        for (const [key, value] of fields) setLine(lines, key, value);
        fs.writeFileSync(file, `---\n${lines.join('\n')}\n---\n${text ? `\n${text}\n` : ''}`);
      } else {
        const base = slugify(title);
        slug = base;
        for (let i = 2; fs.existsSync(path.join(dir, `${slug}.md`)); i++) slug = `${base}-${i}`;
        file = path.join(dir, `${slug}.md`);
        const fm = fields.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `---\n${fm.join('\n')}\n---\n${text ? `\n${text}\n` : ''}`);
      }
      reply(200, { file: path.relative(process.cwd(), file), slug });
    });
  };
}
