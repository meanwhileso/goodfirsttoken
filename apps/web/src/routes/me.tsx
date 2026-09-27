import { productName } from '@goodfirsttoken/core';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { Button } from '../components/Button';
import { Marker } from '../components/Marker';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import accountCss from '../styles/account-page.css?url';

// The signed-in person's own page. For now it says who is signed in and
// holds the sign-out button. #27 builds the review queue and connected agents
// from prototype/me.html.
export const Route = createFileRoute('/me')({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: '/sign-in' });
    return { viewer: context.viewer };
  },
  head: () => ({
    meta: [{ title: `Me · ${productName}` }],
    links: [{ rel: 'stylesheet', href: accountCss }],
  }),
  component: Me,
});

function Me() {
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <SiteNav current="me" />
      <main className="wrap account">
        <h1 className="account__title">@{viewer.login}</h1>
        <p className="lede account__lede">You&apos;re signed in with GitHub.</p>
        <section className="account__section stack">
          <Marker as="h2">github access</Marker>
          <SplitBadges>
            <SplitBadge rule="scope" value="public_repo" strict />
            <SplitBadge rule="private repos" value="never" />
          </SplitBadges>
        </section>
        <form method="post" action="/auth/sign-out">
          <Button type="submit">Sign out</Button>
        </form>
        <p className="small muted account__note">
          Signing out revokes the GitHub token this site holds for you, and signs you out in every browser.
        </p>
      </main>
    </>
  );
}
