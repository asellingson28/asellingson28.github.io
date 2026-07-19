# aselling.us

[![Playwright Tests](https://github.com/asellingson28/asellingson28.github.io/actions/workflows/playwright.yml/badge.svg)](https://github.com/asellingson28/asellingson28.github.io/actions/workflows/playwright.yml)

[![Unit Tests](https://github.com/asellingson28/asellingson28.github.io/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/asellingson28/asellingson28.github.io/actions/workflows/unit-tests.yml)

[![Deploy](https://github.com/asellingson28/asellingson28.github.io/actions/workflows/deploy.yml/badge.svg)](https://github.com/asellingson28/asellingson28.github.io/actions/workflows/deploy.yml)


Personal site built with [Astro](https://astro.build), deployed to GitHub Pages. Contains public data of projects, places, media, and my in progress blog.

## Commands

- `npm run dev` — dev server
- `npm run build` — static build to `dist/`
- `npm run preview` — serve the built site
- `npx playwright test` — end-to-end tests (builds the site and serves it before running)
- `npm run test:unit` — unit tests for `scripts/`; `cd worker && npm test` for the subscribe Worker's own suite
