import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addressFromFormatted,
  coverRawUrl,
  createTransporter,
  escapeHtml,
  maskEmail,
  renderEmailCard,
  stripTags,
  wrapEmailPreviewDocument,
} from './mail-theme.mjs';

describe('maskEmail', () => {
  it('keeps the first two characters of the local part', () => {
    expect(maskEmail('arjan.ellingson@gmail.com')).toBe('ar*************@gmail.com');
  });

  it('masks a single trailing character for very short local parts', () => {
    expect(maskEmail('ab@example.com')).toBe('a*@example.com');
    expect(maskEmail('a@example.com')).toBe('a*@example.com');
  });

  it('unwraps "Name <email>" formatted addresses first', () => {
    expect(maskEmail('Arjan <arjan.ellingson@gmail.com>')).toBe('ar*************@gmail.com');
  });

  it('falls back to a generic mask when there is no domain', () => {
    expect(maskEmail('not-an-email')).toBe('no***');
  });
});

describe('addressFromFormatted', () => {
  it('extracts the address out of "Name <email>"', () => {
    expect(addressFromFormatted('Arjan Ellingson <arjan@example.com>')).toBe('arjan@example.com');
  });

  it('passes a bare address through unchanged', () => {
    expect(addressFromFormatted('arjan@example.com')).toBe('arjan@example.com');
  });
});

describe('escapeHtml', () => {
  it('escapes all five reserved HTML characters', () => {
    expect(escapeHtml(`<a href="x">it's & "quoted"</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;quoted&quot;&lt;/a&gt;'
    );
  });
});

describe('stripTags', () => {
  it('removes markup but keeps text content', () => {
    expect(stripTags('<p>hello <strong>world</strong></p>')).toBe('hello world');
  });
});

describe('coverRawUrl', () => {
  it('resolves a relative cover path against the markdown file location', () => {
    const url = coverRawUrl('src/content/blog/on-slow-technology.md', './cover.jpg');
    expect(url).toBe(
      'https://raw.githubusercontent.com/asellingson28/asellingson28.github.io/main/src/content/blog/cover.jpg'
    );
  });

  it('returns undefined when there is no cover value', () => {
    expect(coverRawUrl('src/content/blog/post.md', undefined)).toBeUndefined();
  });
});

describe('renderEmailCard', () => {
  it('includes the CTA link and escapes the title', () => {
    const html = renderEmailCard({
      eyebrow: 'test',
      title: `<script>alert(1)</script>`,
      cta: { href: 'https://example.com/confirm?token=abc', label: 'Confirm →' },
      footerHtml: 'footer',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('https://example.com/confirm?token=abc');
  });

  it('omits the cover/body/cta rows entirely when not provided', () => {
    const html = renderEmailCard({ eyebrow: 'e', title: 't', footerHtml: 'f' });
    expect(html).not.toContain('data-role="cover"');
  });
});

describe('wrapEmailPreviewDocument', () => {
  it('wraps a fragment with an explicit utf-8 charset', () => {
    const doc = wrapEmailPreviewDocument('<p>hi</p>', { title: 'Preview' });
    expect(doc).toContain('<meta charset="utf-8" />');
    expect(doc).toContain('<title>Preview</title>');
    expect(doc).toContain('<p>hi</p>');
  });
});

describe('createTransporter', () => {
  const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
  const ENV_KEYS = [...REQUIRED, 'SMTP_PORT', 'SMTP_SECURE'];
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function setEnv(overrides) {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, {
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'user@example.com',
      SMTP_PASS: 'app-password',
      MAIL_FROM: 'Arjan <arjan@example.com>',
      ...overrides,
    });
  }

  it('throws listing every missing required var', () => {
    setEnv({});
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM;
    expect(() => createTransporter()).toThrow(/SMTP_HOST, MAIL_FROM/);
  });

  it('rejects a host with stray whitespace/quotes/protocol from a copy-pasted secret', () => {
    setEnv({ SMTP_HOST: '"smtp.gmail.com"' });
    expect(() => createTransporter()).toThrow(/should be only a hostname/);

    setEnv({ SMTP_HOST: 'smtp://smtp.gmail.com' });
    expect(() => createTransporter()).toThrow(/should be only a hostname/);
  });

  it('rejects a non-numeric port', () => {
    setEnv({ SMTP_PORT: 'not-a-number' });
    expect(() => createTransporter()).toThrow(/SMTP_PORT should be a number/);
  });

  it('builds a transporter for a valid, well-formed config', () => {
    setEnv({ SMTP_PORT: '587', SMTP_SECURE: 'false' });
    expect(() => createTransporter()).not.toThrow();
  });
});
