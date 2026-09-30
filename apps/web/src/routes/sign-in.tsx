import { productName } from '@goodfirsttoken/core';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { Button } from '../components/Button';
import accountCss from '../styles/account-page.css?url';
import { routeHead } from '../readable/head';

// Sign in with GitHub. The form posts to src/auth/routes.ts, which sends the
// person to GitHub and back to /me. A sign-in that failed comes back here
// with ?error=.
export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === 'string' ? { error: search.error } : {},
  beforeLoad: ({ context }) => {
    if (context.viewer) throw redirect({ to: '/me' });
  },
  head: ({ matches }) =>
    routeHead(
      matches,
      { title: `Sign in · ${productName}`, description: 'Sign in to Good First Token with your GitHub account.', path: '/sign-in' },
      [{ rel: 'stylesheet', href: accountCss }],
    ),
  component: SignIn,
});

function SignIn() {
  const { error } = Route.useSearch();
  return (
    <>
      <SiteNav />
      <main className="wrap account">
        <h1 className="account__title">Sign in</h1>
        <p className="lede account__lede">Good First Token uses your GitHub account.</p>
        {error !== undefined && (
          <p className="account__error" role="alert">
            Sign-in didn&apos;t finish. Try again.
          </p>
        )}
        <form method="post" action="/auth/sign-in">
          <Button type="submit" variant="primary">
            Sign in with GitHub
          </Button>
        </form>
        <p className="small muted account__note">
          It asks GitHub for <span className="mono">public_repo</span> only. That can fork a public repo, commit to
          the fork, and open a pull request. It can&apos;t read private repos.
        </p>
      </main>
    </>
  );
}
