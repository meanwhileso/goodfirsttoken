import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { SiteNav } from '../../auth/SiteNav';
import { Button } from '../../components/Button';
import { loadConsent } from '../../mcp/consent';
import { AUTHORIZE_PATH } from '../../mcp/paths';
import accountCss from '../../styles/account-page.css?url';
import { routeHead } from '../../readable/head';

// The page where a person approves an agent that wants to connect to the MCP
// server. The agent sends the browser here, and src/mcp/consent.ts checks its
// request. The form posts to the same path, which src/mcp/authorize.ts
// answers: Continue goes on to GitHub, and Cancel goes back to the agent. A
// request that isn't right gets an error here. When the agent should hear
// it, a link goes back to the agent, and only the person follows it.

export const Route = createFileRoute('/oauth/authorize')({
  loader: ({ location }) => loadConsent({ data: location.searchStr }),
  // A step in one agent's sign-in, which no search engine lists.
  head: ({ matches }) =>
    routeHead(matches, { title: `Connect an agent · ${productName}`, path: null }, [{ rel: 'stylesheet', href: accountCss }]),
  component: ConnectAgent,
});

function ConnectAgent() {
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav />
      <main className="wrap account">
        <h1 className="account__title">Connect an agent</h1>
        {page.kind === 'error' ? (
          <>
            <p className="account__error" role="alert">
              {page.message}
            </p>
            {page.back && (
              <>
                <p className="account__note">{page.back.reason}</p>
                <p className="account__note">
                  To tell the agent, go back to{' '}
                  <a className="mono" href={page.back.href}>
                    {page.back.to}
                  </a>
                  . Follow the link only if you just connected an agent from there.
                </p>
              </>
            )}
          </>
        ) : (
          <>
            <p className="lede account__lede">
              <span className="strong">{page.clientName}</span> wants to act as you on {productName}.
            </p>
            <p className="account__note">
              The agent provides this name. {productName} cannot verify it. Access goes to{' '}
              <span className="mono strong">{page.sendsTo}</span>.
            </p>
            {page.local && (
              <p className="account__note" role="note">
                That is an app on your computer. Continue only if you just connected one from it.
              </p>
            )}
            <p className="account__note">
              Signing in with GitHub lets this agent fork public repos, commit to forks, and open pull requests
              through {productName}. It cannot read private repos.
            </p>
            <form method="post" action={AUTHORIZE_PATH} className="cluster">
              <input type="hidden" name="handle" value={page.handle} />
              <Button type="submit" name="decision" value="approve" variant="primary">
                Continue with GitHub
              </Button>
              <Button type="submit" name="decision" value="deny">
                Cancel
              </Button>
            </form>
            <p className="small muted account__note">
              You can disconnect it at any time on <a href="/me">your page</a>.
            </p>
          </>
        )}
      </main>
    </>
  );
}
