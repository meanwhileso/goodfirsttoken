import { useRouteContext } from '@tanstack/react-router';
import { Nav, type NavPage } from '../components/Nav';

/** The site nav, showing the signed-in person's login when there is one. */
export function SiteNav({ current }: { current?: NavPage }) {
  const { viewer } = useRouteContext({ from: '__root__' });
  return <Nav current={current} user={viewer ?? undefined} />;
}
