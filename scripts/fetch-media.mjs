// Snapshots Goodreads + Letterboxd RSS feeds into src/data/*.json.
// Run with `npm run fetch:media` (also run daily by .github/workflows/refresh-media.yml).
// Like the geocode cache, the snapshots are committed so builds need no network.
// `fetchedAt` is only bumped when feed content actually changes, so the
// "last updated" footers on /books and /films reflect real updates and the
// daily workflow produces no commit when nothing changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GOODREADS_USER_ID = '192886223';
const LETTERBOXD_USER = 'aselling';

const dataDir = fileURLToPath(new URL('../src/data/', import.meta.url));

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// Pull one tag's text out of an <item> block; unwraps CDATA and entities.
const pick = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  const cdata = m[1].trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decode((cdata ? cdata[1] : m[1]).trim());
};

const toIsoDate = (s) => {
  const d = new Date(s);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString().slice(0, 10);
};

// Strip HTML down to plain text, keeping paragraph/line breaks.
const htmlToText = (html) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .trim();

async function fetchXml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'asellingson28.github.io media snapshot (arjan.ellingson@gmail.com)' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const items = (xml) => xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];

// --- Goodreads ---------------------------------------------------------

function parseBook(item) {
  const bookId = pick(item, 'book_id');
  return {
    title: pick(item, 'title'),
    author: pick(item, 'author_name'),
    link: `https://www.goodreads.com/book/show/${bookId}`,
    cover: pick(item, 'book_large_image_url') || pick(item, 'book_image_url') || null,
    rating: Number(pick(item, 'user_rating')) || 0,
    readAt: toIsoDate(pick(item, 'user_read_at')),
    addedAt: toIsoDate(pick(item, 'user_date_added')),
    review: htmlToText(pick(item, 'user_review')) || null,
  };
}

async function fetchShelf(shelf) {
  const books = [];
  const seen = new Set();
  // list_rss serves up to 100 items per page
  for (let page = 1; page <= 10; page++) {
    const xml = await fetchXml(
      `https://www.goodreads.com/review/list_rss/${GOODREADS_USER_ID}?shelf=${shelf}&page=${page}`
    );
    const pageItems = items(xml);
    if (pageItems.length === 0) break;
    const guids = pageItems.map((it) => pick(it, 'guid'));
    if (seen.has(guids[0])) break; // page param exhausted/ignored
    guids.forEach((g) => seen.add(g));
    books.push(...pageItems.map(parseBook));
    if (pageItems.length < 100) break;
  }
  return books;
}

// --- Letterboxd --------------------------------------------------------

function parseFilm(item) {
  const description = pick(item, 'description');
  const rating = Number(pick(item, 'letterboxd:memberRating'));
  return {
    title: pick(item, 'letterboxd:filmTitle'),
    year: Number(pick(item, 'letterboxd:filmYear')) || null,
    link: pick(item, 'link'),
    poster: description.match(/<img src="([^"]+)"/)?.[1] ?? null,
    rating: rating || null, // 0.5–5 in halves; absent when unrated
    liked: pick(item, 'letterboxd:memberLike') === 'Yes',
    rewatch: pick(item, 'letterboxd:rewatch') === 'Yes',
    watchedDate: pick(item, 'letterboxd:watchedDate') || null,
    review: htmlToText(description.replace(/<p><img[^>]*\/?><\/p>/, '')) || null,
  };
}

async function fetchFilms() {
  const xml = await fetchXml(`https://letterboxd.com/${LETTERBOXD_USER}/rss/`);
  // diary entries only — the feed also carries list updates (guid letterboxd-list-…)
  return items(xml)
    .filter((it) => /letterboxd-(watch|review)-/.test(pick(it, 'guid')))
    .map(parseFilm);
}

// --- write, preserving fetchedAt when content is unchanged -------------

function writeSnapshot(file, data) {
  const path = dataDir + file;
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  const unchanged =
    previous &&
    JSON.stringify({ ...previous, fetchedAt: null }) === JSON.stringify({ ...data, fetchedAt: null });
  if (unchanged) {
    console.log(`${file}: unchanged (last update ${previous.fetchedAt})`);
    return;
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`${file}: updated`);
}

const fetchedAt = new Date().toISOString();

const [read, currentlyReading, films] = await Promise.all([
  fetchShelf('read'),
  fetchShelf('currently-reading'),
  fetchFilms(),
]);

const byRecency = (a, b) => (b.readAt ?? b.addedAt ?? '').localeCompare(a.readAt ?? a.addedAt ?? '');
read.sort(byRecency);

writeSnapshot('goodreads.json', { fetchedAt, userId: GOODREADS_USER_ID, currentlyReading, read });
writeSnapshot('letterboxd.json', { fetchedAt, username: LETTERBOXD_USER, films });
console.log(`${read.length} read, ${currentlyReading.length} currently reading, ${films.length} films`);
