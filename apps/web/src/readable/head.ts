import { productName } from '@goodfirsttoken/core';

// Each page's metadata in its <head>: the title, the description, the
// canonical URL, the Open Graph tags that chat apps and search engines read,
// and a link to the page's markdown version. The origin is the site's own,
// from the root route's loader (src/routes/__root.tsx), which reads it from
// the environment (siteOrigin in src/auth/settings.ts), never from a file.

type Meta = Record<string, string>;
type HeadLink = Record<string, string>;

/** The markdown version of a page's path: `/index.md` for the homepage, and the path plus `.md` for the rest. */
export function markdownPath(path: string): string {
  return path === '/' ? '/index.md' : `${path}.md`;
}

/** The loader data of the root route, which holds the site's origin. */
interface RootData {
  origin: string;
}

function isRootData(value: unknown): value is RootData {
  return typeof value === 'object' && value !== null && typeof (value as { origin?: unknown }).origin === 'string';
}

/** The site's origin, from the root route's match, or null before it loaded. */
export function originFrom(matches: readonly { routeId: string; loaderData?: unknown }[]): string | null {
  const root = matches.find((match) => match.routeId === '__root__');
  return isRootData(root?.loaderData) ? root.loaderData.origin : null;
}

export interface PageMeta {
  title: string;
  description?: string;
  /**
   * The page's own path, like `/projects`, for its canonical URL, its
   * og:url, and its markdown version. Null for a page that shouldn't be in
   * search results: a page that isn't there, one for the signed-in person
   * alone, or a step in an agent's sign-in. Those get `noindex`.
   */
  path: string | null;
}

/**
 * The meta tags and links for a page. Its share card's og:image tags come
 * from the route, through routeHead, and the root route names the default
 * card (src/cards/meta.ts).
 */
export function pageHead(origin: string | null, page: PageMeta): { meta: Meta[]; links: HeadLink[] } {
  const meta: Meta[] = [{ title: page.title }, { property: 'og:title', content: page.title }];
  if (page.description !== undefined) {
    meta.push({ name: 'description', content: page.description }, { property: 'og:description', content: page.description });
  }
  meta.push({ property: 'og:site_name', content: productName }, { property: 'og:type', content: 'website' });
  const links: HeadLink[] = [];
  if (page.path === null) {
    meta.push({ name: 'robots', content: 'noindex' });
  } else if (origin !== null) {
    const url = `${origin}${page.path}`;
    meta.push({ property: 'og:url', content: url });
    links.push(
      { rel: 'canonical', href: url },
      { rel: 'alternate', type: 'text/markdown', href: `${origin}${markdownPath(page.path)}` },
    );
  }
  return { meta, links };
}

/**
 * A route's head: the page's metadata from pageHead, with the origin from
 * the root route's match, the route's own links, like its stylesheet, and
 * its own meta tags, like its share card's.
 */
export function routeHead(
  matches: readonly { routeId: string; loaderData?: unknown }[],
  page: PageMeta,
  links: HeadLink[] = [],
  meta: Meta[] = [],
): { meta: Meta[]; links: HeadLink[] } {
  const head = pageHead(originFrom(matches), page);
  return { meta: [...head.meta, ...meta], links: [...head.links, ...links] };
}
