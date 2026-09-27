import { productName } from '@goodfirsttoken/core';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { Button } from '../components/Button';
import { Marker } from '../components/Marker';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import { getConnectedAgents } from '../mcp/agents';
import type { Connection } from '../mcp/connections';
import accountCss from '../styles/account-page.css?url';

// The signed-in person's own page. It says who is signed in, lists the agents
// they connected to the MCP server, each with Disconnect, and holds the
// sign-out button. #27 builds the review queue from prototype/me.html.
export const Route = createFileRoute('/me')({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: '/sign-in' });
    return { viewer: context.viewer };
  },
  loader: () => getConnectedAgents(),
  head: () => ({
    meta: [{ title: `Me · ${productName}` }],
    links: [{ rel: 'stylesheet', href: accountCss }],
  }),
  component: Me,
});

// Times show in UTC, to the minute, so the page reads the same on the server
// and in the browser.
function when(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function ConnectedAgents({ agents }: { agents: Connection[] }) {
  return (
    <section className="account__section stack">
      <Marker as="h2">connected agents</Marker>
      {agents.length === 0 ? (
        <p className="small muted">No agents connected.</p>
      ) : (
        <ul className="account__agents">
          {agents.map((agent) => (
            <li key={agent.id} className="account__agent">
              <span>
                <span className="strong">{agent.clientName}</span>
                <br />
                <span className="mono small faint">
                  connected {when(agent.connectedAt)} · last used {when(agent.lastUsedAt)}
                </span>
              </span>
              <form method="post" action="/auth/agents/disconnect">
                <input type="hidden" name="agent" value={agent.id} />
                <Button type="submit" variant="danger" size="sm" aria-label={`Disconnect ${agent.clientName}`}>
                  Disconnect
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted account__note">
        Removing the server from an agent doesn&apos;t tell us. Disconnect it here to revoke its GitHub token.
      </p>
    </section>
  );
}

function Me() {
  const { viewer } = Route.useRouteContext();
  const agents = Route.useLoaderData();
  return (
    <>
      <SiteNav current="me" />
      <main className="wrap account">
        <h1 className="account__title">@{viewer.login}</h1>
        <p className="lede account__lede">You&apos;re signed in with GitHub.</p>
        <ConnectedAgents agents={agents} />
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
