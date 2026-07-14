// Dev-only endpoints behind the blog editor on /blog (mounted at /__edit-blog
// by scripts/dev-add-place.mjs — never part of the built site).
// POST /__edit-blog/save { slug?, title, date, description?, tags?, draft?, coverCaption?, body }
//   with slug: rewrites the managed frontmatter fields of an existing post,
//   leaving anything else in the frontmatter untouched, and replaces the body
//   without slug: creates src/content/blog/<slug-from-title>.md
// POST /__edit-blog/image?slug=<slug>&name=<filename>  (raw image body)
//   saves the post's cover photo as <slug>-cover.<ext> next to the .md file
//   and sets its `cover:` frontmatter line
// POST /__edit-blog/preview { title, description?, tags?, coverCaption?, body }
//   renders the not-yet-saved fields through the same markdown pipeline the
//   real site uses (title/description/tags/coverCaption via inline-markdown.mjs,
//   body via @astrojs/markdown-remark + the site's remark plugins) so the
//   preview can't silently drift from what the built post will look like
// NOTE: loaded once at dev-server startup — restart `npm run dev` after edits.
import fs from 'node:fs';
import path from 'node:path';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkFootnoteTitles from './remark-footnote-titles.mjs';
import { renderInlineMarkdown } from '../src/lib/inline-markdown.mjs';

// created lazily (it's not free) and reused across preview requests
let processorPromise;
function getMarkdownProcessor() {
  if (!processorPromise) processorPromise = createMarkdownProcessor({ remarkPlugins: [remarkFootnoteTitles] });
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
