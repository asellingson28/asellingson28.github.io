# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — dev server (also enables the in-browser content editors, see below)
- `npm run build` — static build to `dist/`
- `npm run preview` — serve the built site
- `npx playwright test` — e2e tests; single file: `npx playwright test tests/example.spec.ts`; single test: `npx playwright test -g "test name"`; one browser: `--project=chromium`
- No lint script; `prettier` is available as a devDependency (`npx prettier`)

**Ports:** 4321/4322 are reserved for the user's own dev server — never bind to them or kill what's running there. For testing, use `--port 4329` for `astro dev` and `--port 4323` for `astro preview`.

Note: `playwright.config.ts` has no `webServer` configured — tests don't start the dev server themselves. `tests/example.spec.ts` is still the Playwright scaffold (tests playwright.dev, not this site).

## What this is

A personal site built with Astro 6, deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main` (build → upload `dist/` → deploy). Playwright CI runs on push/PR. `_config.yml` is a leftover from the old Jekyll version of the site and is unused.

## Architecture

### Content collections (`src/content.config.ts`)

Two collections, both markdown-with-frontmatter loaded by glob:

- **`blog`** (`src/content/blog/*.md`): `title`, `date`, optional `description`/`tags`/`draft`. Draft handling: dev shows drafts (so they can be edited), builds exclude them — `src/pages/blog/index.astro` filters with `import.meta.env.DEV || !draft`, `src/pages/blog/[...slug].astro` filters them out of `getStaticPaths` unconditionally.
- **`places`** (`src/content/places/*.md`): one file per map marker for the Places map. `kind` is `event | travel | lived`. Each entry needs either `coords: [lat, lng]` or a `location` string that gets geocoded at build time. The markdown body becomes the popup notes.

### Places map (`src/pages/travels.astro`)

The most involved page. At build time it resolves coordinates, optimizes photos through `astro:assets`, and serializes everything into an inline JSON `<script>`; a client-side Leaflet script renders markers, layer-toggle legend, and popups. Markers cluster via `leaflet.markercluster` (one cluster group for all kinds; the legend toggles add/remove each kind's markers from it, and cluster icons scale with count).

- **Geocoding** (`src/lib/geocode.ts`): Nominatim, rate-limited to 1 req/s, results cached in `src/data/geocode-cache.json`. The cache is committed on purpose — each location string is looked up once, ever, and CI builds need no network. A `null` cache entry means "Nominatim had no match, don't re-ask"; fix the location string or add explicit `coords`.
- **Photos**: images dropped in `src/content/places/<slug>/` auto-attach to that place, ordered by filename (prefix `01-`, `02-`… to control order). Frontmatter `images` entries are listed first; folder images are deduped against them.

### Media snapshots (`/books`, `/films`)

`scripts/fetch-media.mjs` (`npm run fetch:media`) snapshots Goodreads shelf RSS (user `192886223`, shelves `read` + `currently-reading`) and the Letterboxd diary RSS (user `aselling`) into `src/data/goodreads.json` / `src/data/letterboxd.json`. Like the geocode cache, the snapshots are committed so builds need no network. `fetchedAt` is only bumped when feed content actually changes — the pages render it in a "most recent update" footer, and it keeps the refresh workflow from committing no-op changes. `.github/workflows/refresh-media.yml` re-runs the fetch daily, commits if changed, and dispatches `deploy.yml` (a push from `GITHUB_TOKEN` won't trigger it otherwise). Letterboxd RSS only carries the ~50 most recent diary entries; Goodreads covers and Letterboxd posters are hotlinked, not downloaded.

### Dev-only content editors

Content is authored through the browser in dev. A Vite plugin (`scripts/dev-add-place.mjs`, registered in `astro.config.mjs`) mounts POST-only endpoints on the dev server:

- `/__add-place` (create), `/__add-place/update` (edit), `/__add-place/image` (photo upload) — driven by the "+ add place" / "edit" UI on the travels map
- `/__edit-blog/save` (create/edit posts; handler in `scripts/dev-edit-blog.mjs`) — driven by the "+ new post" / "edit" UI on `/blog`

These write markdown files into `src/content/`. Updates rewrite only the form-managed frontmatter fields and leave everything else (comments, `location`, `coords`, `images`) untouched — preserve that behavior when changing them. All editor UI is guarded by `import.meta.env.DEV`, which is statically false in builds, so none of it ships.

**Gotcha:** the middleware scripts are loaded once at dev-server startup — after editing anything in `scripts/`, restart `npm run dev` or requests hit the old handler.

### Markdown pipeline

`scripts/remark-footnote-titles.mjs` (wired in `astro.config.mjs`) rewrites links inside footnote definitions to use the fetched page `<title>` as link text. Titles are cached in `.cache/footnote-titles.json` (gitignored, so a fresh clone re-fetches on first build). Reddit links are left as raw URLs (Cloudflare blocks the fetch).

## Styling

Design tokens live in `src/styles/global.css` (imported by `src/layouts/BaseLayout.astro`, which every page uses). The direction is "technical drafting / blueprint": dark ground, hairline gold rules, steel-blue accents, and monospace annotations via the `mono-label` class — pages open with a `mono-label` index marker like `index / 02`. Use the existing CSS custom properties (`--color-*`, `--font-*`, `--space-*`) rather than hardcoding values.
