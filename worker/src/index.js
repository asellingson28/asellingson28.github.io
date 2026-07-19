// Public backend for the blog's "subscribe" form. Lives outside the static
// site (GitHub Pages can't run server code) and owns exactly one thing: the
// list of confirmed subscriber emails, stored in the SUBSCRIBERS KV
// namespace. It never sees SMTP credentials or GitHub tokens — those stay in
// GitHub Actions, which polls this Worker on a schedule.
//
// KV layout:
//   pending:<token>  -> { email, requestedAt, emailedAt? }   (48h TTL)
//   confirmed         -> JSON array of confirmed emails
//   ratelimit:<ip>    -> request count this hour               (1h TTL)

const SITE_ORIGIN = 'https://aselling.us';
const DEV_ORIGINS = ['http://localhost:4321', 'http://localhost:4322', 'http://localhost:4329'];
const PENDING_TTL_SECONDS = 60 * 60 * 48;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors scripts/lib/mail-theme.mjs's EMAIL_THEME. Duplicated (not
// imported) on purpose: that module pulls in nodemailer, which doesn't
// belong in a Workers bundle, and it's a handful of hex values, not worth a
// shared-build step across two different runtimes.
const THEME = {
  bg: '#0a0d12',
  card: '#10141c',
  line: '#232b38',
  gold: '#c9a227',
  blueBright: '#7fb0e0',
  text: '#e4e1d8',
  textDim: '#8a8f98',
  textFaint: '#565c68',
};

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (char) => entities[char]);
}

function corsHeaders(origin) {
  const allowed = origin === SITE_ORIGIN || DEV_ORIGINS.includes(origin) ? origin : SITE_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function htmlPage({ eyebrow, title, body }) {
  const t = THEME;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} &middot; aselling</title>
</head>
<body style="margin:0;background:${t.bg};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${t.text};display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;">
<div style="max-width:480px;width:100%;background:${t.card};border:1px solid ${t.line};">
<div style="height:3px;background:${t.gold};background-image:linear-gradient(90deg, ${t.gold} 0%, ${t.line} 50%, ${t.blueBright} 100%);"></div>
<div style="padding:40px;">
<span style="font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${t.textFaint};">${escapeHtml(eyebrow)}</span>
<h1 style="margin:12px 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:26px;line-height:1.3;color:${t.text};">${escapeHtml(title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:${t.textDim};">${escapeHtml(body)}</p>
<p style="margin:24px 0 0;"><a href="${SITE_ORIGIN}/blog" style="color:${t.blueBright};text-decoration:none;font-size:14px;">&larr; back to the blog</a></p>
</div>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mirrors scripts/lib/mail-theme.mjs's maskEmail. Duplicated for the same
// reason as THEME above — not worth a shared-build step for one function.
function maskEmail(email) {
  const [user, domain] = email.split('@');
  if (!domain) return `${email.slice(0, 2)}***`;
  const maskedUser = user.length <= 2 ? `${user[0] ?? ''}*` : `${user.slice(0, 2)}${'*'.repeat(user.length - 2)}`;
  return `${maskedUser}@${domain}`;
}

// Every path through handleSubscribe() ends in the same generic {ok:true}
// response by design (see genericOk() below), so a legitimate signup that
// gets silently dropped — honeypot false-positive from browser autofill,
// rate limiting, a typo'd address — leaves no trace anywhere else. Logging
// the reason here is the only way to diagnose "my friend says they signed up
// but never got an email" after the fact, via wrangler tail or the
// dashboard's Logs tab (see wrangler.toml's `observability` block).
function logSubscribeEvent(event, detail) {
  console.log(JSON.stringify({ event: `subscribe_${event}`, ...detail }));
}

// Finds an existing pending: entry for this email, if any. O(n) in the
// number of currently-pending signups, which for a personal blog's
// subscribe form is never going to be large enough to matter.
async function findPendingByEmail(env, email) {
  const { keys } = await env.SUBSCRIBERS.list({ prefix: 'pending:' });
  for (const key of keys) {
    const raw = await env.SUBSCRIBERS.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    if (data.email === email) return { key: key.name, data };
  }
  return null;
}

function requireAuth(request, env) {
  return request.headers.get('Authorization') === `Bearer ${env.SYNC_SECRET}`;
}

async function getConfirmed(env) {
  const raw = await env.SUBSCRIBERS.get('confirmed');
  return raw ? JSON.parse(raw) : [];
}

async function checkRateLimit(env, ip) {
  const key = `ratelimit:${ip}`;
  const raw = await env.SUBSCRIBERS.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= RATE_LIMIT_MAX) return false;
  await env.SUBSCRIBERS.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

async function handleSubscribe(request, env, origin) {
  const headers = corsHeaders(origin);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, { status: 400, headers });
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const honeypot = String(body.website ?? '');
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  // Always return the same generic "ok" shape for honeypot hits, malformed
  // addresses, rate-limited IPs, and already-subscribed addresses — never
  // give a bot (or a nosy visitor) a way to tell which case happened, or
  // enumerate whether a given address is already on the list.
  const genericOk = () => json({ ok: true }, { headers });

  if (honeypot) {
    logSubscribeEvent('skip_honeypot', { ip });
    return genericOk();
  }
  if (!EMAIL_RE.test(email) || email.length > 320) {
    logSubscribeEvent('skip_invalid_email', { ip });
    return genericOk();
  }

  if (!(await checkRateLimit(env, ip))) {
    logSubscribeEvent('skip_rate_limited', { ip, email: maskEmail(email) });
    return genericOk();
  }

  const confirmed = await getConfirmed(env);
  if (confirmed.includes(email)) {
    logSubscribeEvent('skip_already_confirmed', { email: maskEmail(email) });
    return genericOk();
  }

  // If this address already has a live pending token, don't pile on a
  // second one — that would just queue duplicate confirmation emails on the
  // next cron run. But if the existing one was already emailed (and the
  // person is back submitting the form again, e.g. because they never got
  // it or lost the link), replace it with a fresh token so they get a real
  // new attempt instead of silently doing nothing.
  const existing = await findPendingByEmail(env, email);
  if (existing) {
    if (!existing.data.emailedAt) {
      logSubscribeEvent('skip_duplicate_pending', { email: maskEmail(email) });
      return genericOk();
    }
    await env.SUBSCRIBERS.delete(existing.key);
    logSubscribeEvent('resend', { email: maskEmail(email) });
  }

  const token = randomToken();
  await env.SUBSCRIBERS.put(`pending:${token}`, JSON.stringify({ email, requestedAt: Date.now() }), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
  logSubscribeEvent('queued', { email: maskEmail(email) });

  return genericOk();
}

async function handlePending(request, env) {
  if (!requireAuth(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });

  const { keys } = await env.SUBSCRIBERS.list({ prefix: 'pending:' });
  const entries = [];
  for (const key of keys) {
    const raw = await env.SUBSCRIBERS.get(key.name);
    if (!raw) continue;
    const data = JSON.parse(raw);
    if (data.emailedAt) continue;
    entries.push({ token: key.name.slice('pending:'.length), email: data.email });
  }
  return json({ pending: entries });
}

async function handleMarkEmailed(request, env) {
  if (!requireAuth(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const tokens = Array.isArray(body.tokens) ? body.tokens : [];

  for (const token of tokens) {
    const key = `pending:${token}`;
    const raw = await env.SUBSCRIBERS.get(key);
    if (!raw) continue;
    const data = JSON.parse(raw);
    data.emailedAt = Date.now();
    await env.SUBSCRIBERS.put(key, JSON.stringify(data), { expirationTtl: PENDING_TTL_SECONDS });
  }

  return json({ ok: true });
}

async function handleConfirm(url, env) {
  const token = url.searchParams.get('token') ?? '';
  const key = `pending:${token}`;
  const raw = token ? await env.SUBSCRIBERS.get(key) : null;

  if (!raw) {
    logSubscribeEvent('confirm_invalid_token', {});
    return htmlPage({
      eyebrow: 'subscribe · error',
      title: 'Link expired',
      body: 'This confirmation link is invalid or has expired. Head back to the blog and sign up again.',
    });
  }

  const { email } = JSON.parse(raw);
  const confirmed = await getConfirmed(env);
  if (!confirmed.includes(email)) {
    confirmed.push(email);
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(confirmed));
  }
  await env.SUBSCRIBERS.delete(key);
  logSubscribeEvent('confirmed', { email: maskEmail(email) });

  return htmlPage({
    eyebrow: 'subscribe · confirmed',
    title: "You're subscribed",
    body: `${email} will now get an email whenever a new post goes up.`,
  });
}

async function handleSubscribers(request, env) {
  if (!requireAuth(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
  return json({ subscribers: await getConfirmed(env) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env, origin);
    }
    if (url.pathname === '/pending' && request.method === 'GET') {
      return handlePending(request, env);
    }
    if (url.pathname === '/mark-emailed' && request.method === 'POST') {
      return handleMarkEmailed(request, env);
    }
    if (url.pathname === '/confirm' && request.method === 'GET') {
      return handleConfirm(url, env);
    }
    if (url.pathname === '/subscribers' && request.method === 'GET') {
      return handleSubscribers(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};
