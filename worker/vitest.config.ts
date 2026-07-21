import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // SYNC_SECRET and UNSUBSCRIBE_SECRET are real Worker secrets in
      // production (wrangler secret put) so they aren't in wrangler.toml —
      // tests need their own values to exercise the auth-gated/token-verified
      // endpoints.
      miniflare: {
        bindings: { SYNC_SECRET: 'test-sync-secret', UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret' },
      },
    }),
  ],
});
