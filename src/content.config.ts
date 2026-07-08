import { defineCollection, z } from 'astro:content';
import { glob } from 'node_modules/astro/dist/content/loaders/glob';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),

  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string().optional(),
    draft: z.boolean().optional().default(false),
    tags: z.array(z.string()).optional(),
  }),
});

export const collections = { blog };