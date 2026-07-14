// Runs cspell over the same files as `npm run spellcheck` and adds every
// word it flags as unknown into cspell.json's `words` list — for clearing a
// batch of flagged proper nouns/jargon in one shot instead of one at a time.
// Run with `npm run spellcheck:add-words`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const cspellConfigPath = fileURLToPath(new URL('../cspell.json', import.meta.url));

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const globs = pkg.scripts.spellcheck.match(/"[^"]+"/g)?.map((s) => s.slice(1, -1));
if (!globs?.length) throw new Error('could not parse file globs out of the "spellcheck" npm script');

function cspell(extraArgs) {
  try {
    return execFileSync('npx', ['cspell', '--no-progress', ...extraArgs, ...globs], { encoding: 'utf8' });
  } catch (err) {
    // cspell exits 1 when it finds issues — expected here, not a failure.
    // Its output is still on stdout either way.
    if (typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

const found = cspell(['--words-only', '--unique'])
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);

if (!found.length) {
  console.log('No unknown words found — nothing to add.');
  process.exit(0);
}

const raw = fs.readFileSync(cspellConfigPath, 'utf8');
const config = JSON.parse(raw);
const existing = new Set(config.words ?? []);
const added = found.filter((w) => !existing.has(w));

if (!added.length) {
  console.log('All flagged words are already in cspell.json.');
  process.exit(0);
}

const merged = [...existing, ...added].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

// Splice just the "words" array back into the original text (rather than
// re-serializing the whole file) so unrelated formatting — e.g. the
// single-line "dictionaries"/"ignoreRegExpList" arrays — is left untouched.
const wordsBlockRe = /"words"\s*:\s*\[[^\]]*\]/s;
if (!wordsBlockRe.test(raw)) throw new Error('could not find a "words" array in cspell.json');
const rendered = `"words": [\n${merged.map((w) => `    ${JSON.stringify(w)}`).join(',\n')}\n  ]`;
fs.writeFileSync(cspellConfigPath, raw.replace(wordsBlockRe, rendered));

console.log(`Added ${added.length} word${added.length === 1 ? '' : 's'} to cspell.json:`);
for (const w of added) console.log(`  ${w}`);
