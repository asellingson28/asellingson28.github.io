import { defineConfig } from 'astro/config';
import remarkFootnoteTitles from './scripts/remark-footnote-titles.mjs';
import rehypeImageCaptions from './scripts/rehype-image-captions.mjs';
import devAddPlace from './scripts/dev-add-place.mjs';

export default defineConfig({
  site: 'https://aselling.us',
  markdown: {
    remarkPlugins: [remarkFootnoteTitles],
    rehypePlugins: [rehypeImageCaptions],
  },
  vite: {
    plugins: [devAddPlace()],
  },
});