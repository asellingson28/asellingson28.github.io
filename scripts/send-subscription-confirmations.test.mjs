import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmationEmail, fetchPending, markEmailed, run } from './send-subscription-confirmations.mjs';

const WORKER_URL = 'https://worker.example.workers.dev';
const SYNC_SECRET = 'shh';

describe('confirmationEmail', () => {
  it('builds a confirm link carrying the token, and includes it in both text and html', () => {
    const email = confirmationEmail(
      { email: 'friend@example.com', token: 'abc123' },
      { workerUrl: WORKER_URL, from: 'Arjan <arjan@aselling.us>', replyTo: undefined }
    );

    expect(email.to).toBe('friend@example.com');
    expect(email.subject).toBe('Confirm your subscription');
    expect(email.text).toContain(`${WORKER_URL}/confirm?token=abc123`);
    expect(email.html).toContain(`${WORKER_URL}/confirm?token=abc123`);
    expect(email.html).toContain('Confirm subscription');
  });

  it('carries replyTo through when provided', () => {
    const email = confirmationEmail(
      { email: 'friend@example.com', token: 'tok' },
      { workerUrl: WORKER_URL, from: 'a@b.com', replyTo: 'help@aselling.us' }
    );
    expect(email.replyTo).toBe('help@aselling.us');
  });
});

describe('fetchPending / markEmailed', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetchPending sends the bearer token and returns the pending array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pending: [{ token: 't1', email: 'x@example.com' }] }),
    });
    global.fetch = fetchMock;

    const result = await fetchPending(WORKER_URL, SYNC_SECRET);

    expect(result).toEqual([{ token: 't1', email: 'x@example.com' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${WORKER_URL}/pending`);
    expect(init.headers.Authorization).toBe(`Bearer ${SYNC_SECRET}`);
  });

  it('fetchPending throws on a non-OK response instead of silently returning nothing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchPending(WORKER_URL, SYNC_SECRET)).rejects.toThrow(/401/);
  });

  it('fetchPending tolerates a malformed body by returning an empty array', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await fetchPending(WORKER_URL, SYNC_SECRET)).toEqual([]);
  });

  it('markEmailed is a no-op for an empty token list (does not call the Worker)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    await markEmailed(WORKER_URL, SYNC_SECRET, []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('markEmailed posts the token list with auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    await markEmailed(WORKER_URL, SYNC_SECRET, ['t1', 't2']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${WORKER_URL}/mark-emailed`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${SYNC_SECRET}`);
    expect(JSON.parse(init.body)).toEqual({ tokens: ['t1', 't2'] });
  });

  it('markEmailed logs but does not throw when the Worker call fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(markEmailed(WORKER_URL, SYNC_SECRET, ['t1'])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('run', () => {
  const originalFetch = global.fetch;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('throws when WORKER_URL/SYNC_SECRET are missing, before touching the network', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    await expect(run({ workerUrl: undefined, syncSecret: undefined })).rejects.toThrow(
      /WORKER_URL, SYNC_SECRET/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing and reports zero pending when the queue is empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pending: [] }) });
    const result = await run({ workerUrl: WORKER_URL, syncSecret: SYNC_SECRET });
    expect(result).toEqual({ pendingCount: 0, sent: [], failed: [] });
  });

  it('dry-run reports counts without sending mail or calling the transporter', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pending: [{ token: 't1', email: 'a@example.com' }] }),
    });
    const transporterFactory = vi.fn();

    const result = await run({
      dryRun: true,
      workerUrl: WORKER_URL,
      syncSecret: SYNC_SECRET,
      transporterFactory,
    });

    expect(result).toEqual({ pendingCount: 1, sent: [], failed: [], dryRun: true });
    expect(transporterFactory).not.toHaveBeenCalled();
  });

  it('only marks successfully-sent tokens as emailed, leaving failures for the next run', async () => {
    const pending = [
      { token: 'ok-token', email: 'good@example.com' },
      { token: 'bad-token', email: 'bad@example.com' },
    ];
    const fetchMock = vi.fn((input) => {
      const url = String(input);
      if (url.endsWith('/pending')) {
        return Promise.resolve({ ok: true, json: async () => ({ pending }) });
      }
      if (url.endsWith('/mark-emailed')) {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    global.fetch = fetchMock;

    const sendMail = vi.fn(async (mail) => {
      if (mail.to === 'bad@example.com') throw new Error('SMTP said no');
      return { rejected: [] };
    });
    const transporterFactory = () => ({ verify: vi.fn(), sendMail });

    const result = await run({ workerUrl: WORKER_URL, syncSecret: SYNC_SECRET, transporterFactory });

    expect(result.sent).toEqual(['ok-token']);
    expect(result.failed).toEqual([pending[1]]);

    const markEmailedCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/mark-emailed'));
    expect(JSON.parse(markEmailedCall[1].body)).toEqual({ tokens: ['ok-token'] });
  });

  it('treats an SMTP-rejected recipient the same as a thrown send error', async () => {
    const pending = [{ token: 't1', email: 'rejected@example.com' }];
    global.fetch = vi.fn((input) => {
      const url = String(input);
      if (url.endsWith('/pending')) return Promise.resolve({ ok: true, json: async () => ({ pending }) });
      return Promise.resolve({ ok: true });
    });
    const sendMail = vi.fn().mockResolvedValue({ rejected: ['rejected@example.com'] });
    const transporterFactory = () => ({ verify: vi.fn(), sendMail });

    const result = await run({ workerUrl: WORKER_URL, syncSecret: SYNC_SECRET, transporterFactory });

    expect(result.sent).toEqual([]);
    expect(result.failed).toEqual(pending);
  });
});
