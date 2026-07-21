// Public URL of the Cloudflare Worker backing the blog's subscribe form (see
// worker/README.md). Not a secret — it's baked into the client-side form
// bundle already. Shared so SubscribeForm.astro and the dev-only test-email
// endpoints (scripts/dev-add-place.mjs) can't drift apart on a Worker
// redeploy under a different subdomain.
export const WORKER_URL = 'https://aselling-blog-subscribe.aselling.workers.dev';
