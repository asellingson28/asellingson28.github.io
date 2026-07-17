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
const GITHUB_USER = 'asellingson28';

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

// --- GitHub --------------------------------------------------------------

async function fetchGithubRepos() {
  const res = await fetch(`https://api.github.com/users/${GITHUB_USER}/repos?type=owner&sort=pushed&per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'asellingson28.github.io media snapshot (arjan.ellingson@gmail.com)',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for GitHub repos`);
  const repos = await res.json();
  // forks and archived repos are noise on a "what I'm working on" list
  return repos
    .filter((r) => !r.fork && !r.archived)
    .map((r) => ({
      name: r.name,
      description: r.description,
      link: r.html_url,
      homepage: r.homepage || null,
      language: r.language,
      stars: r.stargazers_count,
      topics: r.topics ?? [],
      pushedAt: toIsoDate(r.pushed_at),
    }));
}

// The 12-month contribution calendar (the graph on a GitHub profile) is only
// exposed via GraphQL and requires an authenticated token — the public REST
// API has no equivalent. Needs a token in GH_CONTRIB_TOKEN (repo secret in
// CI); any authenticated token works since the data itself is public. When
// no token is available (e.g. a contributor's local checkout), skip and let
// the caller fall back to whatever's already committed.
async function fetchContributionCalendar() {
  if (!process.env.GH_CONTRIB_TOKEN) {
    console.log('contribution calendar: GH_CONTRIB_TOKEN not set, skipping');
    return null;
  }
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${process.env.GH_CONTRIB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'asellingson28.github.io media snapshot (arjan.ellingson@gmail.com)',
    },
    body: JSON.stringify({ query, variables: { login: GITHUB_USER } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for GitHub contribution calendar`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  const calendar = json.data.user.contributionsCollection.contributionCalendar;
  return {
    total: calendar.totalContributions,
    days: calendar.weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount })),
  };
}

// Repos owned by someone else that the user has contributed real code to —
// GitHub's own profile page surfaces the same list. Also GraphQL-only, so it
// shares fetchContributionCalendar's token/fallback story above.
// `contributionTypes: [COMMIT, PULL_REQUEST]` is a proxy for "substantial
// contribution" (as opposed to just opening an issue or leaving a PR review)
// since the API has no numeric "how much did I contribute" field to filter on.
// GH_CONTRIB_TOKEN typically carries the `repo` scope (needed for the private
// contribution counts in the calendar above), so this query — unlike the
// unauthenticated REST call in fetchGithubRepos — can see private repos the
// user has access to. isPrivate is filtered out below; this snapshot is
// committed to the repo and rendered on the public site, so a private repo
// name/description/link must never end up in it.
async function fetchContributedRepos() {
  if (!process.env.GH_CONTRIB_TOKEN) {
    console.log('contributed repos: GH_CONTRIB_TOKEN not set, skipping');
    return null;
  }
  const query = `
    query($login: String!) {
      user(login: $login) {
        repositoriesContributedTo(
          first: 100
          includeUserRepositories: false
          contributionTypes: [COMMIT, PULL_REQUEST]
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            name
            owner { login }
            description
            url
            homepageUrl
            primaryLanguage { name }
            stargazerCount
            isFork
            isArchived
            isPrivate
            pushedAt
          }
        }
      }
    }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${process.env.GH_CONTRIB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'asellingson28.github.io media snapshot (arjan.ellingson@gmail.com)',
    },
    body: JSON.stringify({ query, variables: { login: GITHUB_USER } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for GitHub contributed repos`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  // forks and archived repos are noise here too (mirrors fetchGithubRepos);
  // private repos are excluded outright — see the note above
  return json.data.user.repositoriesContributedTo.nodes
    .filter((r) => !r.isFork && !r.isArchived && !r.isPrivate)
    .map((r) => ({
      name: r.name,
      owner: r.owner.login,
      description: r.description,
      link: r.url,
      homepage: r.homepageUrl || null,
      language: r.primaryLanguage?.name ?? null,
      stars: r.stargazerCount,
      pushedAt: toIsoDate(r.pushedAt),
    }));
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
    // internal-only: matches data-viewing-id on the diary listing page (see
    // fetchDiaryPosters) so a per-entry custom poster can be spliced in;
    // stripped out before the snapshot is written.
    viewingId: pick(item, 'guid').match(/-(\d+)$/)?.[1] ?? null,
  };
}

async function fetchFilms() {
  const xml = await fetchXml(`https://letterboxd.com/${LETTERBOXD_USER}/rss/`);
  // Diary entries only. The feed also carries list updates (guid letterboxd-list-…)
  // and "watched/reviewed" activity that was never logged to the diary — those
  // share the watch/review guid prefixes but have no letterboxd:watchedDate, so
  // filter on that instead of guid alone. Feed order is activity order (when an
  // entry was logged/edited), not diary order, so re-sort by watchedDate.
  const films = items(xml)
    .filter((it) => /letterboxd-(watch|review)-/.test(pick(it, 'guid')) && pick(it, 'letterboxd:watchedDate'))
    .map(parseFilm);
  films.sort((a, b) => b.watchedDate.localeCompare(a.watchedDate));
  return films;
}

// --- Letterboxd favorites + watchlist (scraped — not available via RSS) ---

// Both the favorites grid and the watchlist grid render posters via a React
// component that resolves the image client-side — a plain HTML fetch only
// ever sees a placeholder src, and Letterboxd's underlying image-lookup
// endpoint sits behind a Cloudflare JS challenge. A real browser is the only
// way to read the resolved <img src>.
function parseGridEntries(entries, cropFrom) {
  return entries.map(({ fullName, path, poster }) => {
    const [, title, year] = fullName.match(/^(.*)\s\((\d{4})\)$/) ?? [null, fullName, null];
    return {
      title,
      year: year ? Number(year) : null,
      link: `https://letterboxd.com${path}`,
      poster: poster && !poster.includes('empty-poster') ? poster.replace(cropFrom, '-0-600-0-900-crop') : null,
    };
  });
}

async function fetchFavorites(page) {
  // networkidle is unreliable here (see fetchWatchlist) — domcontentloaded +
  // polling for resolved posters is faster and more consistent.
  await page.goto(`https://letterboxd.com/${LETTERBOXD_USER}/`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => !document.querySelector('#favourites img[src*="empty-poster"]'), { timeout: 15000 })
    .catch(() => {}); // fall through with whatever resolved in time

  const entries = await page.$$eval('#favourites .favourite-production-poster-container', (nodes) =>
    nodes.map((node) => ({
      fullName: node.querySelector('.react-component')?.getAttribute('data-item-full-display-name') ?? '',
      path: node.querySelector('.react-component')?.getAttribute('data-item-link') ?? '',
      poster: node.querySelector('img')?.getAttribute('src') ?? null,
    }))
  );

  // bump the served crop up from the profile grid's 150×225 thumbnail
  return parseGridEntries(entries, '-0-150-0-225-crop');
}

// Top 20 by popularity; the `/by/popular/` sort puts them in order, so the
// first page (28 items) always has enough to slice from.
async function fetchWatchlist(page) {
  // networkidle is unreliable here (the grid page keeps background requests
  // going); domcontentloaded + polling for resolved posters is faster and more consistent.
  await page.goto(`https://letterboxd.com/${LETTERBOXD_USER}/watchlist/by/popular/`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => !document.querySelector('.griditem img[src*="empty-poster"]'), { timeout: 15000 })
    .catch(() => {});

  const entries = await page.$$eval('.griditem .react-component', (nodes) =>
    nodes.slice(0, 20).map((node) => ({
      fullName: node.getAttribute('data-item-full-display-name') ?? '',
      path: node.getAttribute('data-item-link') ?? '',
      poster: node.querySelector('img')?.getAttribute('src') ?? null,
    }))
  );

  return parseGridEntries(entries, '-0-125-0-187-crop');
}

// A diary entry can carry a per-log custom poster (an alternate official
// poster, or a self-uploaded image) that the member chose, which differs
// from the film's default poster embedded in the RSS feed. The diary
// listing page renders each row keyed by data-viewing-id — the same numeric
// id as the suffix on each RSS item's guid (see parseFilm's `viewingId`) —
// so rows can be matched back to films even across rewatches. Posters lazy-
// load on scroll, so a tall viewport is used instead of scrolling to force
// every row to resolve at once.
async function fetchDiaryPosters(page) {
  const posters = new Map();
  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const url =
      pageNum === 1
        ? `https://letterboxd.com/${LETTERBOXD_USER}/films/diary/`
        : `https://letterboxd.com/${LETTERBOXD_USER}/films/diary/page/${pageNum}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => !document.querySelector('.diary-entry-row .poster img[src*="empty-poster"]'), undefined, {
        timeout: 20000,
      })
      .catch(() => {}); // fall through with whatever resolved in time

    const rows = await page.$$eval('tr.diary-entry-row', (nodes) =>
      nodes.map((n) => ({
        viewingId: n.getAttribute('data-viewing-id'),
        poster: n.querySelector('.poster.film-poster img')?.getAttribute('src') ?? null,
      }))
    );
    if (rows.length === 0) break;
    for (const { viewingId, poster } of rows) {
      if (viewingId && poster && !poster.includes('empty-poster')) {
        posters.set(viewingId, poster.replace(/-0-\d+-0-\d+-crop/, '-0-600-0-900-crop'));
      }
    }
    if (rows.length < 50) break; // last page
  }
  return posters;
}

async function fetchFavoritesAndWatchlist() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  try {
    const contextOptions = {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 asellingson28.github.io media snapshot (arjan.ellingson@gmail.com)',
    };
    // Separate contexts per page: reusing one session for both requests trips
    // Letterboxd's Cloudflare bot check on the second navigation.
    const favoritesContext = await browser.newContext(contextOptions);
    const favorites = await fetchFavorites(await favoritesContext.newPage());
    await favoritesContext.close();

    const watchlistContext = await browser.newContext(contextOptions);
    const watchlist = await fetchWatchlist(await watchlistContext.newPage());
    await watchlistContext.close();

    // Custom posters are additive/optional — if the diary listing fails to
    // load (Cloudflare, timeout), fall back to the RSS default posters
    // rather than failing the whole media fetch over it.
    let diaryPosters = new Map();
    try {
      const diaryContext = await browser.newContext({ ...contextOptions, viewport: { width: 1280, height: 20000 } });
      diaryPosters = await fetchDiaryPosters(await diaryContext.newPage());
      await diaryContext.close();
    } catch (err) {
      console.warn(`diary posters: skipping (${err.message})`);
    }

    return { favorites, watchlist, diaryPosters };
  } finally {
    await browser.close();
  }
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

const [
  read,
  currentlyReading,
  toRead,
  rawFilms,
  { favorites, watchlist, diaryPosters },
  repos,
  fetchedCalendar,
  fetchedContributedRepos,
] = await Promise.all([
  fetchShelf('read'),
  fetchShelf('currently-reading'),
  fetchShelf('to-read'),
  fetchFilms(),
  fetchFavoritesAndWatchlist(),
  fetchGithubRepos(),
  fetchContributionCalendar(),
  fetchContributedRepos(),
]);

const byRecency = (a, b) => (b.readAt ?? b.addedAt ?? '').localeCompare(a.readAt ?? a.addedAt ?? '');
read.sort(byRecency);
toRead.sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));

// The favorites/watchlist/diary poster resolution races Letterboxd's
// Cloudflare JS challenge (see fetchFavorites/fetchWatchlist/fetchDiaryPosters)
// — it's more prone to timing out from a CI runner's datacenter IP than a
// local run, which would otherwise erase a previously-resolved poster. Keep
// the last known poster (matched by link) rather than let a slow challenge
// wipe it.
let previousLetterboxd = null;
try {
  previousLetterboxd = JSON.parse(readFileSync(dataDir + 'letterboxd.json', 'utf8'));
} catch {}
const previousFilmByLink = new Map((previousLetterboxd?.films ?? []).map((f) => [f.link, f]));

const films = rawFilms.map(({ viewingId, ...film }) => {
  const custom = diaryPosters.get(viewingId);
  if (custom) return { ...film, poster: custom };
  // No custom poster resolved this run for this diary entry — that's the
  // normal case for entries with no custom poster, but also what a failed/
  // partial diary scrape looks like. Fall back to whatever poster (custom or
  // default) this same film had last time rather than reverting it.
  const previousPoster = previousFilmByLink.get(film.link)?.poster;
  return previousPoster ? { ...film, poster: previousPoster } : film;
});

// fetchContributionCalendar/fetchContributedRepos return null when no token
// is configured — keep whatever was last committed rather than wiping it out.
const previousGithub = (() => {
  try {
    return JSON.parse(readFileSync(dataDir + 'github.json', 'utf8'));
  } catch {
    return null;
  }
})();
const contributions = fetchedCalendar ?? previousGithub?.contributions ?? null;
const contributedRepos = fetchedContributedRepos ?? previousGithub?.contributedRepos ?? [];

function backfillPosters(entries, previousEntries) {
  const previousByLink = new Map((previousEntries ?? []).map((e) => [e.link, e.poster]));
  return entries.map((e) => (e.poster ? e : { ...e, poster: previousByLink.get(e.link) ?? null }));
}

writeSnapshot('goodreads.json', { fetchedAt, userId: GOODREADS_USER_ID, currentlyReading, toRead, read });
writeSnapshot('letterboxd.json', {
  fetchedAt,
  username: LETTERBOXD_USER,
  films,
  favorites: backfillPosters(favorites, previousLetterboxd?.favorites),
  watchlist: backfillPosters(watchlist, previousLetterboxd?.watchlist),
});
writeSnapshot('github.json', { fetchedAt, username: GITHUB_USER, repos, contributions, contributedRepos });
console.log(
  `${read.length} read, ${currentlyReading.length} currently reading, ${toRead.length} to read, ${films.length} films, ${favorites.length} favorites, ${watchlist.length} watchlist, ${repos.length} repos, ${contributedRepos.length} contributed repos`
);
