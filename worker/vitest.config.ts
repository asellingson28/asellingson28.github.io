import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // SYNC_SECRET is a real Worker secret in production (wrangler secret
      // put) so it isn't in wrangler.toml — tests need their own value to
      // exercise the auth-gated endpoints.
      miniflare: {
        bindings: { SYNC_SECRET: 'test-sync-secret' },
      },
    }),
  ],
});
