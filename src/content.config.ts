import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),

  schema: ({ image }) =>
    z.object({
      title: z.string(),
      date: z.date(),
      description: z.string().optional(),
      draft: z.boolean().optional().default(false),
      tags: z.array(z.string()).optional(),
      // art/photo shown beside the post in the list, e.g. cover: ./my-post-cover.jpg
      cover: image().optional(),
      coverCaption: z.string().optional(),
    }),
});

// One markdown file per place for the concerts/shows/travels map.
// Give each entry either a `location` string (geocoded at build time)
// or explicit `coords: [lat, lng]`. Photos live next to the .md file
// and are referenced with relative paths in `images`.
const places = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/places' }),

  schema: ({ image }) =>
    z
      .object({
        name: z.string(),
        kind: z.enum(['event', 'travel', 'lived', 'want-to-go']),
        location: z.string().optional(),
        coords: z.tuple([z.number(), z.number()]).optional(),
        date: z.string().optional(),
        detail: z.string().optional(),
        images: z.array(image()).optional().default([]),
      })
      .refine((p) => p.location || p.coords, {
        message: 'A place needs either `location` (geocoded at build) or `coords: [lat, lng]`.',
      }),
});

export const collections = { blog, places };