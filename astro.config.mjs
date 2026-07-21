import { defineConfig } from 'astro/config';
import remarkFootnoteTitles from './scripts/remark-footnote-titles.mjs';
import remarkFlexibleMarkers from 'remark-flexible-markers';
import rehypeImageCaptions from './scripts/rehype-image-captions.mjs';
import devAddPlace from './scripts/dev-add-place.mjs';

export default defineConfig({
  site: 'https://aselling.us',
  markdown: {
    // remarkFlexibleMarkers: `==highlighted text==` -> <mark>. Not
    // CommonMark/GFM syntax; this is a real micromark extension (unlike a
    // hand-rolled post-parse text-node scan) so nested inline markdown like
    // `==**bold**==` or `==[a link](url)==` still parses correctly. See
    // "Markdown pipeline" in CLAUDE.md.
    remarkPlugins: [remarkFootnoteTitles, [remarkFlexibleMarkers, { actionForEmptyContent: 'keep' }]],
    rehypePlugins: [rehypeImageCaptions],
  },
  vite: {
    plugins: [devAddPlace()],
  },
});