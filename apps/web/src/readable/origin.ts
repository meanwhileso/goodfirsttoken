import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { siteOrigin } from '../auth/settings';

// The site's origin, for every page's canonical URL and Open Graph tags. The
// root route loads it once. It comes from the environment: https on the
// primary domain when there is one, or the origin the request came to. It
// reads no cookie and sets none.
export const getSiteOrigin = createServerFn({ method: 'GET' }).handler((): { origin: string } => ({
  origin: siteOrigin(getRequest()),
}));
