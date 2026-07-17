// Dev-only Vite middleware behind the "+ add place" mode on the travels map.
// POST /__add-place { name, kind, coords: [lat, lng], date?, detail?, notes? }
//   writes src/content/places/<slug>.md
// POST /__add-place/image?slug=<slug>&name=<filename>  (raw image body)
//   writes src/content/places/<slug>/<filename>, which auto-attaches to the place
// POST /__add-place/update { slug, name, kind, date?, detail?, notes? }
//   rewrites the managed fields of an existing <slug>.md, leaving other
//   frontmatter (location, coords, images, comments) untouched
// POST /__add-place/reorder { slug, files: string[] }
//   renumbers src/content/places/<slug>/* with 01-, 02-… prefixes matching
//   the given filename order (folder images are sorted by filename, see top
//   of src/pages/travels.astro)
// Never part of the built site.
// NOTE: this file is loaded once at dev-server startup — after editing it,
// restart `npm run dev` or requests will hit the old handler.
import fs from 'node:fs';
import path from 'node:path';
import { blogEditHandler } from './dev-edit-blog.mjs';

const PLACES_DIR = path.resolve('src/content/places');
const KINDS = ['event', 'travel', 'lived', 'want-to-go', 'third-place'];
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'place';

export default function devAddPlace() {
  return {
    name: 'dev-add-place',
    configureServer(server) {
      server.middlewares.use('/__edit-blog', blogEditHandler());
      server.middlewares.use('/__add-place', (req, res) => {
        const reply = (code, payload) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') return reply(405, { error: 'POST only' });

        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/image') {
          const slug = slugify(String(url.searchParams.get('slug') ?? ''));
          const original = path.basename(String(url.searchParams.get('name') ?? 'photo'));
          const ext = path.extname(original).toLowerCase();
          if (!IMAGE_EXTS.has(ext))
            return reply(400, { error: `unsupported image type "${ext || 'none'}" (HEIC? convert to jpg first)` });
          if (!fs.existsSync(path.join(PLACES_DIR, `${slug}.md`)))
            return reply(400, { error: `no place file for slug "${slug}"` });

          const base = slugify(original.slice(0, -ext.length));
          const dir = path.join(PLACES_DIR, slug);
          let file = path.join(dir, `${base}${ext}`);
          for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}${ext}`);

          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, Buffer.concat(chunks));
            reply(200, { file: path.relative(process.cwd(), file) });
          });
          return;
        }

        if (url.pathname === '/reorder') {
          let reqBody = '';
          req.on('data', (c) => (reqBody += c));
          req.on('end', () => {
            let p;
            try {
              p = JSON.parse(reqBody);
            } catch {
              return reply(400, { error: 'invalid JSON' });
            }
            const slug = slugify(String(p.slug ?? ''));
            const files = Array.isArray(p.files) ? p.files.map((f) => path.basename(String(f))) : [];
            const dir = path.join(PLACES_DIR, slug);
            if (!fs.existsSync(dir)) return reply(400, { error: `no photo folder for slug "${slug}"` });

            const actual = fs
              .readdirSync(dir)
              .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
            const actualSet = new Set(actual);
            if (files.length !== actual.length || !files.every((f) => actualSet.has(f)))
              return reply(400, { error: 'file list does not match the photos on disk — reload and try again' });

            // two-pass rename through temp names so overlapping targets don't collide
            const strip = (base) => base.replace(/^\d+-/, '');
            const temps = files.map((f, i) => {
              const tmp = path.join(dir, `.tmp-reorder-${i}${path.extname(f)}`);
              fs.renameSync(path.join(dir, f), tmp);
              return tmp;
            });
            temps.forEach((tmp, i) => {
              const ext = path.extname(files[i]);
              const base = strip(path.basename(files[i], ext));
              fs.renameSync(tmp, path.join(dir, `${String(i + 1).padStart(2, '0')}-${base}${ext}`));
            });

            reply(200, { slug });
          });
          return;
        }

        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          let p;
          try {
            p = JSON.parse(body);
          } catch {
            return reply(400, { error: 'invalid JSON' });
          }

          const name = String(p.name ?? '').trim();
          const kind = String(p.kind ?? '');
          if (!name) return reply(400, { error: 'name is required' });
          if (!KINDS.includes(kind)) return reply(400, { error: `kind must be one of: ${KINDS.join(', ')}` });
          const date = String(p.date ?? '').trim();
          const detail = String(p.detail ?? '').trim();
          const notes = String(p.notes ?? '').trim();

          if (url.pathname === '/update') {
            const slug = slugify(String(p.slug ?? ''));
            const file = path.join(PLACES_DIR, `${slug}.md`);
            if (!fs.existsSync(file)) return reply(400, { error: `no place file for slug "${slug}"` });

            // rewrite only the fields the form manages; leave everything else
            // (location, coords, images, comments) untouched
            const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
            if (!m) return reply(400, { error: `${slug}.md has no frontmatter` });
            const lines = m[1].split(/\r?\n/);
            const setField = (key, value) => {
              const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
              if (value === undefined) {
                if (idx !== -1) lines.splice(idx, 1);
              } else if (idx !== -1) lines[idx] = `${key}: ${value}`;
              else lines.push(`${key}: ${value}`);
            };
            setField('name', JSON.stringify(name));
            setField('kind', kind);
            setField('date', date ? JSON.stringify(date) : undefined);
            setField('detail', detail ? JSON.stringify(detail) : undefined);
            fs.writeFileSync(file, `---\n${lines.join('\n')}\n---\n${notes ? `\n${notes}\n` : ''}`);
            return reply(200, { file: path.relative(process.cwd(), file), slug });
          }

          const [lat, lng] = Array.isArray(p.coords) ? p.coords.map(Number) : [];
          if (!Number.isFinite(lat) || !Number.isFinite(lng))
            return reply(400, { error: 'coords must be [lat, lng]' });

          const base = slugify(name);
          let slug = base;
          for (let i = 2; fs.existsSync(path.join(PLACES_DIR, `${slug}.md`)); i++) slug = `${base}-${i}`;

          // JSON.stringify produces valid YAML double-quoted scalars
          const fm = [
            `name: ${JSON.stringify(name)}`,
            `kind: ${kind}`,
            `coords: [${lat.toFixed(5)}, ${lng.toFixed(5)}]`,
          ];
          if (date) fm.push(`date: ${JSON.stringify(date)}`);
          if (detail) fm.push(`detail: ${JSON.stringify(detail)}`);

          const file = path.join(PLACES_DIR, `${slug}.md`);
          fs.mkdirSync(PLACES_DIR, { recursive: true });
          fs.writeFileSync(file, `---\n${fm.join('\n')}\n---\n${notes ? `\n${notes}\n` : ''}`);
          reply(200, { file: path.relative(process.cwd(), file), slug });
        });
      });
    },
  };
}
