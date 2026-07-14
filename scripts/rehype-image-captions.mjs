// Wraps `<img>` elements that carry a title — from markdown's
// `![alt](./photo.jpg "caption text")` syntax — in a <figure> with a
// <figcaption>, so inline post images can have a visible caption the way
// the frontmatter `cover`/`coverCaption` pair already does. Runs as a rehype
// plugin (after remark-rehype, before Astro's own image-asset resolution —
// see markdown.rehypePlugins in astro.config.mjs) so it only touches the
// rendered HTML tree; Astro's asset pipeline still finds the <img> and
// optimizes it normally since it does a generic recursive visit for `img`
// elements regardless of how deep they're nested.
// The title is inserted as plain text, not parsed as markdown.
import { visit } from 'unist-util-visit';

export default function rehypeImageCaptions() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'img' || !parent || index == null) return;
      const caption = node.properties?.title;
      if (!caption) return;
      delete node.properties.title;
      parent.children[index] = {
        type: 'element',
        tagName: 'figure',
        properties: {},
        children: [
          node,
          {
            type: 'element',
            tagName: 'figcaption',
            properties: { className: ['mono-label'] },
            children: [{ type: 'text', value: String(caption) }],
          },
        ],
      };
    });
  };
}
