import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { siteOrigin } from '../auth/settings';

// The og:image tags that name a page's share card (./route.ts). A chat or a
// social site reads them from the page's HTML to show its preview. The root
// route names the default card, and a person's page, a project's page, and
// an issue's page each name their own, which takes its place.

/**
 * The site's origin: on the server, the primary domain or the request's
 * own, as siteOrigin says, and in the browser, the page's.
 */
const origin = createIsomorphicFn()
  .server(() => siteOrigin(getRequest()))
  .client(() => window.location.origin);

/** The tags naming the card at `path`, like /@sam/card.png, which Open Graph wants as a full URL. */
export function cardMeta(path: string, alt: string): { property: string; content: string }[] {
  return [
    { property: 'og:image', content: `${origin()}${path}` },
    { property: 'og:image:type', content: 'image/png' },
    { property: 'og:image:width', content: '1200' },
    { property: 'og:image:height', content: '630' },
    { property: 'og:image:alt', content: alt },
  ];
}
