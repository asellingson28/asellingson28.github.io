# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — dev server (also enables the in-browser content editors, see below). Loads `.env.local` first if present (`node --env-file-if-exists=.env.local …`, needs Node ≥20.6) — copy `.env.local.example` to set SMTP/Worker credentials locally without touching GitHub Actions secrets; required to test the dev-only "send test email" buttons below.
- `npm run build` — static build to `dist/`
- `npm run preview` — serve the built site
- `npm run fetch:media` — refresh `src/data/goodreads.json` / `src/data/letterboxd.json` / `src/data/github.json` (see Media snapshots below)
- `npm run notify:blog -- [--dry-run] [--all] [--since <ref>] [file...]` — email subscribers about newly-published posts
- `npm run notify:blog -- --preview <file.md> [file...]` — render the notification email for a post (drafts included, ignores `notify`/`email: false`) to `.cache/email-preview-<slug>.html` and open it; never sends anything or touches the subscriber list
- `npm run notify:confirm -- [--dry-run]` — send pending double opt-in confirmation emails
- `npm run subscribers` — print the Worker's current confirmed subscriber list (delegates to `worker`'s own `subscribers` script, which reads the KV namespace directly via `wrangler kv key get --remote`)
- `npx playwright test` — e2e tests; single file: `npx playwright test tests/example.spec.ts`; single test: `npx playwright test -g "test name"`; one browser: `--project=chromium`
- `npm run test:unit` — vitest over `scripts/**/*.test.mjs` (mail-theme helpers, the confirmation-email sender's pure logic and Worker-fetch orchestration, mocked)
- `npm run spellcheck` — cspell over `src/`, `scripts/`, `worker/`, `tests/`, and root markdown/config files; also runs automatically on `git commit` (staged files only) via the husky hook in `.husky/pre-commit`. Project-specific words (proper nouns, technical terms) live in the `words` list in `cspell.json` — add new ones there rather than disabling the check. `npm run spellcheck:add-words` runs the same check and adds every flagged word to `cspell.json` in one shot instead of one at a time.
- No lint script; `prettier` is available as a devDependency (`npx prettier`)

`worker/` is a separate npm project (Cloudflare Worker, not part of the Astro build) — `cd worker && npm run dev` / `npm run deploy` / `npm test` (vitest via `@cloudflare/vitest-pool-workers`, runs the Worker's real `fetch` handler against a Miniflare-simulated KV binding — see `worker/test/index.test.js`). See `worker/README.md` for one-time setup (KV namespace, secrets).

**Ports:** 4321/4322 are reserved for the user's own dev server — never bind to them or kill what's running there. For testing, use `--port 4329` for `astro dev` and `--port 4323` for `astro preview`.

Note: `playwright.config.ts` has no `webServer` configured — tests don't start the dev server themselves. `tests/example.spec.ts` is still the Playwright scaffold (tests playwright.dev, not this site).

## What this is

A personal site built with Astro 6, deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main` (build → upload `dist/` → deploy). Playwright CI runs on push/PR. GitHub Pages can't run server code, so the one piece of public-facing backend (blog email subscriptions) is a separately-deployed Cloudflare Worker under `worker/` — see "Email subscriptions" below. `_config.yml` is a leftover from the old Jekyll version of the site and is unused.

## Architecture

### Content collections (`src/content.config.ts`)

Two collections, both markdown-with-frontmatter loaded by glob:

- **`blog`** (`src/content/blog/*.md`): `title`, `date`, optional `description`/`tags`/`draft`. Draft handling: dev shows drafts (so they can be edited), builds exclude them — `src/pages/blog/index.astro` filters with `import.meta.env.DEV || !draft`, `src/pages/blog/[...slug].astro` filters them out of `getStaticPaths` unconditionally. `scripts/notify-blog-subscribers.mjs` additionally honors `notify: false` / `email: false` frontmatter to skip emailing a post — those keys aren't in the Zod schema (they're read via that script's own hand-rolled frontmatter parser, not Astro's content API), so they won't show up by grepping the schema.
- **`places`** (`src/content/places/*.md`): one file per map marker for the Places map. `kind` is `event | travel | lived | want-to-go`. Each entry needs either `coords: [lat, lng]` or a `location` string that gets geocoded at build time. The markdown body becomes the popup notes.

### Places map (`src/pages/travels.astro`)

The most involved page. At build time it resolves coordinates, optimizes photos through `astro:assets`, and serializes everything into an inline JSON `<script>`; a client-side Leaflet script renders markers, layer-toggle legend, and popups. Markers cluster via `leaflet.markercluster` (one cluster group for all kinds; the legend toggles add/remove each kind's markers from it, and cluster icons scale with count). Adding a new `kind` touches several spots in this one file (the `MapPlace`/`PlaceKind` types appear twice — once server-side, once in the client `<script>` — plus the legend checkbox, `kindMarkers` init, the dev-form's `KINDS` array, and the `.dot-*`/`.cluster-*` CSS) in addition to the schema enum in `content.config.ts` and the validation list in `scripts/dev-add-place.mjs`.

- **Geocoding** (`src/lib/geocode.ts`): Nominatim, rate-limited to 1 req/s, results cached in `src/data/geocode-cache.json`. The cache is committed on purpose — each location string is looked up once, ever, and CI builds need no network. A `null` cache entry means "Nominatim had no match, don't re-ask"; fix the location string or add explicit `coords`.
- **Photos**: images dropped in `src/content/places/<slug>/` auto-attach to that place, ordered by filename (prefix `01-`, `02-`… to control order). Frontmatter `images` entries are listed first; folder images are deduped against them.

### Theming

Four themes — `odyssey` (default), `sunset`, `cherry`, `monet` — toggled by a slider in `Nav.astro`, which sets `data-theme` on `<html>` and persists the choice to `localStorage`. `BaseLayout.astro` has an inline `is:inline` script in `<head>` that restores the saved theme before first paint (avoids a flash of the default theme). Each theme is a `[data-theme='...']` block in `src/styles/global.css` that redefines the same `--color-*` custom properties as `:root`; anything styled off those tokens (rather than hardcoded hex) reskins automatically. A few one-off decorative colors (e.g. the `lived`/`want-to-go` map dots, the vine/chain ornament colors) are theme-aware too, defined per `[data-theme]` block rather than as swappable tokens.

### Media snapshots (`/books`, `/films`, `/projects`)

`scripts/fetch-media.mjs` (`npm run fetch:media`) snapshots Goodreads shelf RSS (user `192886223`, shelves `read` + `currently-reading` + `to-read`), Letterboxd (user `aselling`), and GitHub (user `asellingson28`) into `src/data/goodreads.json` / `src/data/letterboxd.json` / `src/data/github.json`. Like the geocode cache, the snapshots are committed so builds need no network. `fetchedAt` is only bumped when feed content actually changes — the pages render it in a "most recent update" line, and it keeps the refresh workflow from committing no-op changes. `.github/workflows/refresh-media.yml` re-runs the fetch daily, commits if changed, and dispatches `deploy.yml` (a push from `GITHUB_TOKEN` won't trigger it otherwise).

- **Diary, not activity**: Letterboxd's `/aselling/rss/` feed mixes true diary entries with list updates (guid `letterboxd-list-…`) and "watched/reviewed" activity that was never logged to the diary (same `letterboxd-watch-`/`letterboxd-review-` guid prefixes, but no `letterboxd:watchedDate`). `fetchFilms()` filters on the presence of `watchedDate`, not guid alone, and re-sorts by it — the feed's own order is activity order (when an entry was logged/edited), which drifts from diary order once you backlog an old watch. The feed only carries the ~50 most recent items total, so the diary count on `/films` fluctuates.
- **Favorites + watchlist need a real browser**: Letterboxd's "four favorites" and watchlist grids render posters via a client-side React component (the profile/watchlist HTML only ever has a placeholder `src`), and the underlying image-lookup endpoint sits behind a Cloudflare JS challenge that blocks plain `fetch`. `fetchFavoritesAndWatchlist()` drives headless Chromium via `playwright-core` to read the resolved `<img src>` off each page, then upsizes the served crop dimensions in the URL for a bigger poster. Because of this, `.github/workflows/refresh-media.yml` runs `npm ci` + `npx playwright install --with-deps chromium` before the fetch — don't drop that step even though the rest of the script needs no dependencies.
- **GitHub repos** (`fetchGithubRepos()`) use the public REST API (no auth), filtered to non-fork, non-archived repos, sorted by `pushed_at`.
- **GitHub contribution calendar** (`fetchContributionCalendar()`, rendered as a heatmap on `/projects`) is GraphQL-only — there's no REST equivalent — and GraphQL requires an authenticated token even for public data; the workflow's default `github.token` can't see it. Needs a classic PAT (no special scopes — the calendar is public) in the `GH_CONTRIB_TOKEN` repo secret. When unset (e.g. a contributor's local checkout), the fetch is skipped and `github.json`'s previously-committed `contributions` field is preserved rather than wiped.
- Goodreads covers and Letterboxd posters are hotlinked, not downloaded.

### Email subscriptions

The subscribe form on `/blog` (`src/components/SubscribeForm.astro`) is one of the only things on the site that ships to production and talks to a backend — GitHub Pages is static, so that backend is a Cloudflare Worker + KV under `worker/`, deployed separately (`worker/README.md` has one-time setup and redeploy steps; there's no CI for it). It's a double opt-in flow: the form POSTs to the Worker's `/subscribe`, which queues a pending confirmation rather than adding the address immediately. The Worker's public URL is a single constant in `src/lib/subscribe-worker.mjs`, imported both by `SubscribeForm.astro`'s frontmatter and by the plain-Node `scripts/dev-add-place.mjs` — it's not a secret (already baked into the client bundle), just centralized so a Worker redeploy under a new subdomain can't update one copy and miss the other.

- `scripts/lib/mail-theme.mjs` — shared HTML email styling (mirrors the site's "odyssey" palette with hardcoded hex, since email clients don't load web fonts or CSS custom properties), a `nodemailer` transporter factory, and `buildBlogPostMailOptions()` (the full "new post" message: subject, html, plain-text fallback, List-Unsubscribe headers) shared by `notify-blog-subscribers.mjs` and the dev-only `/send-test-email` endpoint below so the two can't drift apart.
- `scripts/send-subscription-confirmations.mjs` (`npm run notify:confirm`) — polls the Worker's `/pending` for new signups and emails each a confirm link, then reports the sent tokens back to `/mark-emailed`. Run every 15 minutes by `.github/workflows/send-subscription-confirmations.yml`.
- `scripts/notify-blog-subscribers.mjs` (`npm run notify:blog`) — detects newly-published posts via `git diff` against a base ref (or explicit files, or `--all`) and emails them out, one send per recipient (not a bcc'd blast) so each gets their own unsubscribe token. Sends run with bounded concurrency, each isolated in its own try/catch, so one bad address or a transient SMTP error doesn't abort the rest of the list. The recipient list is the union of the manually-managed `MAIL_SUBSCRIBERS` secret and the Worker's confirmed list (fetched from `/subscribers`); if the Worker is unreachable it falls back to just the manual list rather than failing the job. There's no separate "always cc the site owner" recipient — self-subscribe via `MAIL_SUBSCRIBERS` for a copy of your own posts. Wired into `deploy.yml` as a post-deploy job (`--since` the pre-push SHA on a normal push, or a specific file via `workflow_dispatch` for manual testing).
- Both scripts need `WORKER_URL` (a public GitHub Actions **variable**, not a secret) and `SYNC_SECRET` (a secret, shared with the Worker) alongside the usual `SMTP_*`/`MAIL_*` secrets. `notify-blog-subscribers.mjs` additionally needs `UNSUBSCRIBE_SECRET` (a separate secret, also shared with the Worker) to sign each recipient's one-click unsubscribe link via `buildUnsubscribeUrl()`, which normalizes (trims, lowercases) the email before signing — callers (e.g. the manually-managed `MAIL_SUBSCRIBERS` list) can't be trusted to hand it an already-normalized address, and a mismatch here means the link never verifies. Without `UNSUBSCRIBE_SECRET`/`WORKER_URL`, the link falls back to `MAIL_UNSUBSCRIBE`/`UNSUBSCRIBE_URL` or a generic `mailto:`.
- The Worker's `/unsubscribe` (`worker/src/index.js`) only removes the address on POST — GET (a human opening the link) shows a landing page with a button whose form POSTs back to the same URL, it never mutates state itself. This matters because mail security scanners (Safe Links, Proofpoint, etc.) prefetch every link in an email via GET before a human opens it; a GET that unsubscribed immediately would let a scanner silently unsubscribe someone who never clicked anything. The same POST path also serves RFC 8058 one-click unsubscribe (a mail client's own background POST, no browser tab involved).

### Dev-only content editors

Content is authored through the browser in dev. A Vite plugin (`scripts/dev-add-place.mjs`, registered in `astro.config.mjs`) mounts POST-only endpoints on the dev server:

- `/__add-place` (create), `/__add-place/update` (edit), `/__add-place/image` (photo upload) — driven by the "+ add place" / "edit" UI on the travels map
- `/__edit-blog/save` (create/edit posts; handler in `scripts/dev-edit-blog.mjs`) — driven by the "+ new post" / "edit" UI on `/blog`
- `/__edit-blog/send-test-email` — sends a real test of the "new post" notification email (via `buildBlogPostMailOptions`, shared with the real notify script) to an address typed into the post editor's "send test email" row
- `/__test-confirmation-email` — sends a real test of the double opt-in confirmation email (via `confirmationEmail()` from `scripts/send-subscription-confirmations.mjs`) to an address typed into the dev-only block next to `SubscribeForm.astro`. Uses a placeholder token, so the email's "Confirm subscription" link doesn't actually confirm anything real — it's a rendering/deliverability check, not an end-to-end test of the Worker's confirm flow.

These write markdown files into `src/content/`. Updates rewrite only the form-managed frontmatter fields and leave everything else (comments, `location`, `coords`, `images`) untouched — preserve that behavior when changing them. All editor UI is guarded by `import.meta.env.DEV`, which is statically false in builds, so none of it ships. The two test-email endpoints additionally check `isLocalRequest()` (in `scripts/dev-edit-blog.mjs`, based on `req.socket.remoteAddress`, not a spoofable header) and reject anything whose TCP peer isn't loopback — they send real mail through real SMTP credentials, so `astro dev --host` exposing the dev server to the LAN must not turn them into an open relay.

**Gotcha:** the middleware scripts are loaded once at dev-server startup — after editing anything in `scripts/`, restart `npm run dev` or requests hit the old handler.

### Markdown pipeline

`scripts/remark-footnote-titles.mjs` (wired in `astro.config.mjs`) rewrites links inside footnote definitions to use the fetched page `<title>` as link text. Titles are cached in `.cache/footnote-titles.json` (gitignored, so a fresh clone re-fetches on first build). Reddit links are left as raw URLs (Cloudflare blocks the fetch).

`remark-flexible-markers` (an npm dependency, wired in `astro.config.mjs` with `{ actionForEmptyContent: 'keep' }`) turns `==highlighted text==` into `<mark class="flexible-marker flexible-marker-default">` — not CommonMark/GFM syntax. It's a real micromark extension (unlike a hand-rolled post-parse text-node scan), so nested inline markdown like `==**bold**==` still parses correctly, including inside blockquotes. Styled gold (not blue, which is the link color) via a bare `mark` selector in `src/pages/blog/[...slug].astro` and `src/pages/blog/index.astro`'s dev preview. `scripts/dev-edit-blog.mjs`'s `getMarkdownProcessor()` mirrors the same remark/rehype plugin list by hand — add new plugins to both places.

`src/lib/reading-time.mjs`'s `readingTimeLabel(post.body)` renders "x minute read" (200 words/minute, fenced code blocks excluded from the count) next to the date on both the blog list and each post page.

## Styling

Design tokens live in `src/styles/global.css` (imported by `src/layouts/BaseLayout.astro`, which every page uses). The direction is "technical drafting / blueprint": dark ground, hairline gold rules, steel-blue accents, and monospace annotations via the `mono-label` class — pages open with a `mono-label` index marker like `index / 02`. Use the existing CSS custom properties (`--color-*`, `--font-*`, `--space-*`) rather than hardcoding values — see "Theming" above for how those tokens swap per-theme.
