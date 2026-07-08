import { defineConfig } from 'astro/config';
import remarkFootnoteTitles from './scripts/remark-footnote-titles.mjs';

export default defineConfig({
  site: 'https://asellingson28.github.io',
  markdown: {
    remarkPlugins: [remarkFootnoteTitles],
  },
});