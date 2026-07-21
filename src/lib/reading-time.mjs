// "x minute read" label for a post's raw markdown body, at the standard
// 200 words/minute reading pace. Strips fenced code blocks first — code
// isn't read at prose pace, and a large snippet would otherwise skew the
// estimate. Plain .mjs so it can be imported the same way from .astro
// files and (eventually) plain-Node scripts, matching inline-markdown.mjs.
const WORDS_PER_MINUTE = 200;

export function readingTimeLabel(markdown, wordsPerMinute = WORDS_PER_MINUTE) {
  const words = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / wordsPerMinute));
  return `${minutes} minute read`;
}
