# Blog subscribe Worker

Public backend for the "subscribe" form on `/blog`. Deployed separately from
the Astro site (GitHub Pages can't run server code) via Cloudflare Workers +
KV. This Worker owns the pending/confirmed subscriber list; GitHub Actions
polls it on a schedule to send confirmation emails (reusing the site's
existing SMTP creds) and to fetch the confirmed list at send time. This
Worker never holds SMTP credentials or a GitHub token — see `src/index.js`
for the endpoint list and KV layout.

## One-time setup

```sh
cd worker
npm install
npx wrangler login

# Creates the KV namespace; copy the printed id into wrangler.toml's
# kv_namespaces[0].id (replacing REPLACE_WITH_KV_NAMESPACE_ID)
npx wrangler kv namespace create SUBSCRIBERS

# Shared bearer secret for the internal endpoints (/pending, /mark-emailed,
# /subscribers). Generate one, e.g.: openssl rand -hex 32
# Set the SAME value here and as the GitHub repo secret SYNC_SECRET.
npx wrangler secret put SYNC_SECRET

# Signs/verifies the one-click unsubscribe links in the "new post" email
# (scripts/notify-blog-subscribers.mjs builds them, this Worker's /unsubscribe
# verifies them — see verifyUnsubscribeToken in src/index.js). Generate one,
# e.g.: openssl rand -hex 32. Set the SAME value here and as the GitHub repo
# secret UNSUBSCRIBE_SECRET. Deliberately a separate secret from SYNC_SECRET
# so rotating one doesn't invalidate the other's links/auth.
npx wrangler secret put UNSUBSCRIBE_SECRET

npx wrangler deploy
```

`wrangler deploy` prints the Worker's `*.workers.dev` URL. Put that into:

- `src/components/SubscribeForm.astro` — the `WORKER_URL` constant
- the GitHub repo **variable** `WORKER_URL` (not a secret — it's a public URL): `gh variable set WORKER_URL --body "https://..."`

## Redeploying

```sh
cd worker
npm run deploy
```

Deploys are manual — there's no CI pipeline for this Worker. It's small and
expected to change rarely; wire up `wrangler-action` later if that stops
being true.

## Local dev

```sh
cd worker
npm run dev
```

Then point the site's `SubscribeForm.astro` `WORKER_URL` at the printed
`http://localhost:8787` during testing, and run
`scripts/send-subscription-confirmations.mjs` with `WORKER_URL` set to the
same local address to exercise the full subscribe → confirm loop without
touching production KV.
