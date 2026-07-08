import { visit } from 'unist-util-visit';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const CACHE_PATH = './.cache/footnote-titles.json';
if (!existsSync('./.cache')) mkdirSync('./.cache');
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) : {};

function isReddit(url) {
  try {
    return /(^|\.)reddit\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function cleanTitle(title) {
  return title.replace(/\s*[-–—:|]\s*(YouTube|Reddit)\s*$/i, '').trim();
}

async function fetchGenericTitle(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; asellingson28.github.io-footnote-fetcher/1.0)' },
    signal: AbortSignal.timeout(5000),
  });
  const html = await res.text();
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().replace(/\s+/g, ' ') : url;
}

async function fetchTitle(url) {
  // Reddit blocks automated fetches (Cloudflare bot-check) regardless of
  // headers/endpoint — just show the raw URL for any reddit.com link instead
  // of fighting it.
  if (isReddit(url)) return url;

  if (cache[url]) return cache[url];
  try {
    const title = cleanTitle(await fetchGenericTitle(url));
    cache[url] = title;
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    return title;
  } catch {
    return url; // fall back to raw URL if fetch fails
  }
}

export default function remarkFootnoteTitles() {
  return async (tree) => {
    const jobs = [];
    visit(tree, 'footnoteDefinition', (node) => {
      visit(node, 'link', (linkNode) => {
        jobs.push(
          fetchTitle(linkNode.url).then((title) => {
            linkNode.children = [{ type: 'text', value: title }];
          })
        );
      });
    });
    await Promise.all(jobs);
  };
}