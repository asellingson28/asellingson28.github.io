import { reset } from 'cloudflare:test';
import { env, exports as workerExports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';

const worker = workerExports.default;
const BASE_URL = 'https://aselling-blog-subscribe.aselling.workers.dev';
const SITE_ORIGIN = 'https://aselling.us';
const SYNC_SECRET = 'test-sync-secret';
const UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';

afterEach(async () => {
  await reset();
});

function subscribe(body, { origin = SITE_ORIGIN, ip = '203.0.113.1', headers = {} } = {}) {
  return worker.fetch(`${BASE_URL}/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'CF-Connecting-IP': ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// token: null means "send no Authorization header at all" (distinct from
// the default, since a caller explicitly passing `undefined` would
// otherwise silently fall back to it via JS default-parameter semantics).
function authedGet(path, token = SYNC_SECRET) {
  const headers = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(`${BASE_URL}${path}`, { headers });
}

function authedPost(path, body, token = SYNC_SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// Mirrors unsubscribeToken() in scripts/lib/mail-theme.mjs and
// verifyUnsubscribeToken() in src/index.js: HMAC-SHA256("unsubscribe:<email>",
// UNSUBSCRIBE_SECRET), hex-encoded.
async function unsubscribeToken(email, secret = UNSUBSCRIBE_SECRET) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`unsubscribe:${email}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pendingEntries() {
  const { keys } = await env.SUBSCRIBERS.list({ prefix: 'pending:' });
  const entries = [];
  for (const key of keys) {
    entries.push({ key: key.name, data: JSON.parse(await env.SUBSCRIBERS.get(key.name)) });
  }
  return entries;
}

describe('POST /subscribe', () => {
  it('queues a pending confirmation for a valid address', async () => {
    const res = await subscribe({ email: 'Friend@Example.com  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    // trimmed and lowercased before storage
    expect(entries[0].data.email).toBe('friend@example.com');
  });

  it('silently drops honeypot hits without queuing anything', async () => {
    const res = await subscribe({ email: 'bot@example.com', website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('silently drops malformed addresses', async () => {
    const res = await subscribe({ email: 'not-an-email' });
    expect(res.status).toBe(200);
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('silently drops addresses over the length cap', async () => {
    const res = await subscribe({ email: `${'a'.repeat(315)}@x.com` });
    expect(res.status).toBe(200);
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('rate-limits by IP after 5 requests/hour, without ever surfacing that to the caller', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await subscribe({ email: `person${i}@example.com` }, { ip: '198.51.100.9' });
      expect(res.status).toBe(200);
    }
    expect(await pendingEntries()).toHaveLength(5);

    const sixth = await subscribe({ email: 'person6@example.com' }, { ip: '198.51.100.9' });
    expect(sixth.status).toBe(200);
    expect(await sixth.json()).toEqual({ ok: true });
    expect(await pendingEntries()).toHaveLength(5);
  });

  it('tracks rate limits per-IP, not globally', async () => {
    for (let i = 0; i < 5; i++) {
      await subscribe({ email: `a${i}@example.com` }, { ip: '198.51.100.1' });
    }
    const fromOtherIp = await subscribe({ email: 'still-fine@example.com' }, { ip: '198.51.100.2' });
    expect(fromOtherIp.status).toBe(200);
    expect(await pendingEntries()).toHaveLength(6);
  });

  it('does not queue an address that is already confirmed', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['already@example.com']));
    const res = await subscribe({ email: 'already@example.com' });
    expect(res.status).toBe(200);
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('does not create a second pending token for the same address', async () => {
    await subscribe({ email: 'dupe@example.com' }, { ip: '203.0.113.10' });
    const before = await pendingEntries();
    expect(before).toHaveLength(1);

    await subscribe({ email: 'dupe@example.com' }, { ip: '203.0.113.11' });
    const after = await pendingEntries();
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(before[0].key);
  });

  it('re-queues a fresh token when the previous one was already emailed but never confirmed', async () => {
    await subscribe({ email: 'resend@example.com' }, { ip: '203.0.113.20' });
    const [{ key: oldKey }] = await pendingEntries();
    const oldToken = oldKey.slice('pending:'.length);

    const markRes = await authedPost('/mark-emailed', { tokens: [oldToken] });
    expect(markRes.status).toBe(200);

    await subscribe({ email: 'resend@example.com' }, { ip: '203.0.113.21' });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].key).not.toBe(oldKey);
    expect(entries[0].data.email).toBe('resend@example.com');
    expect(entries[0].data.emailedAt).toBeUndefined();
  });

  it('rejects a request whose body is not JSON', async () => {
    const res = await worker.fetch(`${BASE_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /confirm', () => {
  it('moves a pending address to confirmed and deletes the pending entry', async () => {
    await subscribe({ email: 'confirmme@example.com' });
    const [{ key }] = await pendingEntries();
    const token = key.slice('pending:'.length);

    const res = await worker.fetch(`${BASE_URL}/confirm?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // apostrophe comes back HTML-escaped (see escapeHtml in src/index.js)
    expect(html).toContain('You&#39;re subscribed');
    expect(html).toContain('confirmme@example.com will now get an email');

    expect(JSON.parse(await env.SUBSCRIBERS.get('confirmed'))).toContain('confirmme@example.com');
    expect(await env.SUBSCRIBERS.get(key)).toBeNull();
  });

  it('does not duplicate an address that somehow gets confirmed twice', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['dupe-confirm@example.com']));
    await env.SUBSCRIBERS.put(
      'pending:some-token',
      JSON.stringify({ email: 'dupe-confirm@example.com', requestedAt: Date.now() })
    );

    await worker.fetch(`${BASE_URL}/confirm?token=some-token`);
    const confirmed = JSON.parse(await env.SUBSCRIBERS.get('confirmed'));
    expect(confirmed).toEqual(['dupe-confirm@example.com']);
  });

  it('shows an error page for a missing or invalid token, and mutates nothing', async () => {
    const res = await worker.fetch(`${BASE_URL}/confirm?token=does-not-exist`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Link expired');
    expect(await env.SUBSCRIBERS.get('confirmed')).toBeNull();
  });

  it('shows the same error page with no token at all', async () => {
    const res = await worker.fetch(`${BASE_URL}/confirm`);
    expect(await res.text()).toContain('Link expired');
  });
});

describe('GET /unsubscribe', () => {
  // GET must never mutate on its own — mail security scanners (Safe Links,
  // Proofpoint, etc.) prefetch every link in an email via GET before a human
  // ever opens it, so a GET that unsubscribed immediately would let a
  // scanner silently unsubscribe someone who never clicked anything.
  it('does not remove a confirmed address, and shows a confirm-unsubscribe page with a POST form', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['leaving@example.com', 'staying@example.com']));
    const token = await unsubscribeToken('leaving@example.com');

    const res = await worker.fetch(`${BASE_URL}/unsubscribe?email=leaving@example.com&token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Unsubscribe?');
    expect(html).toContain('leaving@example.com');
    expect(html).toMatch(/<form method="POST" action="[^"]*\/unsubscribe\?email=leaving@example\.com&amp;token=/);

    const confirmed = JSON.parse(await env.SUBSCRIBERS.get('confirmed'));
    expect(confirmed).toEqual(['leaving@example.com', 'staying@example.com']);
  });

  it('rejects a token signed for a different email', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['victim@example.com']));
    const token = await unsubscribeToken('attacker@example.com');

    const res = await worker.fetch(`${BASE_URL}/unsubscribe?email=victim@example.com&token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Link invalid');

    const confirmed = JSON.parse(await env.SUBSCRIBERS.get('confirmed'));
    expect(confirmed).toEqual(['victim@example.com']);
  });

  it('rejects a token signed with the wrong secret', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['victim@example.com']));
    const token = await unsubscribeToken('victim@example.com', 'wrong-secret');

    const res = await worker.fetch(`${BASE_URL}/unsubscribe?email=victim@example.com&token=${token}`);
    expect(await res.text()).toContain('Link invalid');
    expect(JSON.parse(await env.SUBSCRIBERS.get('confirmed'))).toEqual(['victim@example.com']);
  });

  it('shows an error page for a missing email or token, and mutates nothing', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['victim@example.com']));
    const token = await unsubscribeToken('victim@example.com');

    const noToken = await worker.fetch(`${BASE_URL}/unsubscribe?email=victim@example.com`);
    expect(await noToken.text()).toContain('Link invalid');

    const noEmail = await worker.fetch(`${BASE_URL}/unsubscribe?token=${token}`);
    expect(await noEmail.text()).toContain('Link invalid');

    expect(JSON.parse(await env.SUBSCRIBERS.get('confirmed'))).toEqual(['victim@example.com']);
  });
});

describe('POST /unsubscribe', () => {
  it('removes a confirmed address and responds 200 (RFC 8058 one-click, and the confirm-form submit)', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['leaving@example.com']));
    const token = await unsubscribeToken('leaving@example.com');

    const res = await worker.fetch(`${BASE_URL}/unsubscribe?email=leaving@example.com&token=${token}`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('You&#39;re unsubscribed');

    expect(JSON.parse(await env.SUBSCRIBERS.get('confirmed'))).toEqual([]);
  });

  it('is a no-op (but still 200) when the address is not in the confirmed list', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['someone-else@example.com']));
    const token = await unsubscribeToken('not-subscribed@example.com');

    const res = await worker.fetch(`${BASE_URL}/unsubscribe?email=not-subscribed@example.com&token=${token}`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You&#39;re unsubscribed");

    const confirmed = JSON.parse(await env.SUBSCRIBERS.get('confirmed'));
    expect(confirmed).toEqual(['someone-else@example.com']);
  });

  it('still responds 200 for an invalid token, never an error status', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['victim@example.com']));

    const res = await worker.fetch(`${BASE_URL}/unsubscribe?email=victim@example.com&token=bogus`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Link invalid');
    expect(JSON.parse(await env.SUBSCRIBERS.get('confirmed'))).toEqual(['victim@example.com']);
  });
});

describe('internal endpoints require the shared secret', () => {
  it.each([
    ['/pending', authedGet],
    ['/subscribers', authedGet],
  ])('%s rejects requests with no Authorization header', async (path, call) => {
    const res = await call(path, null);
    expect(res.status).toBe(401);
  });

  it.each([
    ['/pending', authedGet],
    ['/subscribers', authedGet],
  ])('%s rejects the wrong bearer token', async (path, call) => {
    const res = await call(path, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('/mark-emailed rejects an unauthorized caller', async () => {
    const res = await authedPost('/mark-emailed', { tokens: [] }, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('/pending lists only unemailed entries, keyed by token', async () => {
    await subscribe({ email: 'one@example.com' }, { ip: '203.0.113.30' });
    await subscribe({ email: 'two@example.com' }, { ip: '203.0.113.31' });
    const [{ key }] = (await pendingEntries()).filter((e) => e.data.email === 'one@example.com');
    await authedPost('/mark-emailed', { tokens: [key.slice('pending:'.length)] });

    const res = await authedGet('/pending');
    const { pending } = await res.json();
    expect(pending).toHaveLength(1);
    expect(pending[0].email).toBe('two@example.com');
  });

  it('/subscribers returns the confirmed list', async () => {
    await env.SUBSCRIBERS.put('confirmed', JSON.stringify(['a@example.com', 'b@example.com']));
    const res = await authedGet('/subscribers');
    expect(await res.json()).toEqual({ subscribers: ['a@example.com', 'b@example.com'] });
  });
});

describe('CORS', () => {
  it('reflects the production site origin', async () => {
    const res = await worker.fetch(`${BASE_URL}/subscribe`, {
      method: 'OPTIONS',
      headers: { Origin: SITE_ORIGIN },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
  });

  it('never reflects an untrusted origin back', async () => {
    const res = await worker.fetch(`${BASE_URL}/subscribe`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
  });
});

it('returns 404 for unknown routes', async () => {
  const res = await worker.fetch(`${BASE_URL}/nope`);
  expect(res.status).toBe(404);
});
