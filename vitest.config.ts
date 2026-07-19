import { defineConfig } from 'vitest/config';

// Scoped to scripts/ on purpose: tests/*.spec.ts are Playwright e2e specs
// (run via `npx playwright test`), and vitest's default include glob would
// otherwise also match and try to run them as unit tests.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
  },
});
