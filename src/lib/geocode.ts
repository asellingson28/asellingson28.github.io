// Build-time geocoding via Nominatim (OpenStreetMap's geocoder).
// Results are cached in src/data/geocode-cache.json — commit that file so
// each location is only ever looked up once and CI builds need no network.
import fs from 'node:fs';
import path from 'node:path';

const CACHE_PATH = path.resolve('src/data/geocode-cache.json');

// null in the cache = Nominatim had no result for this string (don't re-ask)
let cache: Record<string, [number, number] | null>;
try {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
} catch {
  cache = {};
}

let lastRequest = 0;

export async function geocode(location: string): Promise<[number, number] | undefined> {
  if (location in cache) {
    const hit = cache[location];
    if (hit === null) {
      console.warn(`[geocode] no match for "${location}" (cached) — fix the location string or set coords`);
      return undefined;
    }
    return hit;
  }

  // Nominatim usage policy: at most 1 request/second
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', location);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '5');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'asellingson28.github.io (personal site places map)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results: { lat: string; lon: string; addresstype?: string }[] = await res.json();

    // "San Luis Obispo, California" ranks the *county* boundary above the
    // city, so prefer the first non-administrative-area match
    const admin = new Set(['county', 'state', 'region', 'province']);
    const best = results.find((r) => !admin.has(r.addresstype ?? '')) ?? results[0];

    const coords: [number, number] | null = best ? [Number(best.lat), Number(best.lon)] : null;
    cache[location] = coords;
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');

    if (!coords) {
      console.warn(`[geocode] no match for "${location}" — fix the location string or set coords`);
      return undefined;
    }
    console.log(`[geocode] "${location}" → [${coords[0]}, ${coords[1]}]`);
    return coords;
  } catch (err) {
    // network failure: warn but don't cache, so the next build retries
    console.warn(`[geocode] lookup failed for "${location}": ${err}`);
    return undefined;
  }
}
