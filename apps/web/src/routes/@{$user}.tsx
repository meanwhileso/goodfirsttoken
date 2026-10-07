import { githubLogin, productName, validate } from '@goodfirsttoken/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { cardMeta } from '../cards/meta';
import { Chip, type ChipVariant } from '../components/Chip';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Prompt } from '../components/Prompt';
import { RailHead } from '../components/Rail';
import { StatLine, type Stat } from '../components/StatLine';
import { TokenField } from '../components/TokenField';
import { Wall } from '../components/Wall';
import { useWallFeed } from '../feed/useWallFeed';
import { WALL_LINES } from '../home/live';
import { prUrl, refName } from '../issue/view';
import { formatRate, formatTokens } from '../leaderboard/format';
import { getPersonPage, type PersonPage, type WorkRow, type WorkStatus } from '../person/data';
import personCss from '../styles/person-page.css?url';
import { routeHead } from '../readable/head';

// One person (brand/brief-website.md): what they are working on now, their
// totals, the activity graph, their history, the projects they helped and
// maintain, and their live feed. The page loads with the person feed's
// newest lines, then follows the feed over the live socket on
// /@<login>/live.ndjson, starting after the newest line it shows.
export const Route = createFileRoute('/@{$user}')({
  loader: async ({ params }) => {
    const page = await getPersonPage({ data: params.user });
    if (page.state === 'not_found') throw notFound();
    return page;
  },
  head: ({ loaderData, params, matches }) => {
    const login = loaderData?.state === 'ready' ? loaderData.login : params.user;
    return routeHead(
      matches,
      {
        title: loaderData ? `@${login} · ${productName}` : `Not found · ${productName}`,
        description:
          loaderData?.state === 'ready'
            ? `Issues @${login}'s agent worked on and PRs maintainers merged.`
            : 'People spending their spare tokens on open source through Good First Token.',
        // By their login now, which the page shows.
        path: loaderData?.state === 'ready' ? `/@${loaderData.login}` : null,
      },
      [{ rel: 'stylesheet', href: personCss }],
      loaderData?.state === 'ready' ? cardMeta(`/@${login}/card.png`, `@${login}'s month on Good First Token.`) : [],
    );
  },
  component: PersonRoute,
  notFoundComponent: NotFoundPerson,
});

function PersonRoute() {
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav />
      <main className="wrap person">
        {page.state === 'ready' ? (
          <Person key={page.login} page={page} />
        ) : (
          <>
            <h1 className="person-title">@{page.login}</h1>
            <p className="person-note">This page can&apos;t be read right now. Try again in a moment.</p>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

// A login no one signed in with, or a blocked donor, reads the same. A path
// no login fits says only that there is no page there.
function NotFoundPerson() {
  const { user } = Route.useParams();
  const login = validate(githubLogin, user).ok ? user : null;
  return (
    <>
      <SiteNav />
      <main className="wrap person">
        <h1 className="person-title person-title--words">Not found</h1>
        <p className="person-lede">
          {login === null ? (
            'There is no page at this address.'
          ) : (
            <>
              <span className="mono">@{login}</span> has no page on Good First Token.
            </>
          )}
        </p>
      </main>
      <Footer />
    </>
  );
}

/** A UTC day, like 2026-09-27, from an ISO 8601 time. */
function day(time: string): string {
  return time.slice(0, 10);
}

/** The month and year someone joined, like sep 2026, in UTC. */
function month(time: string): string {
  return new Date(time).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toLowerCase();
}

function totals(page: PersonPage): Stat[] {
  const { totals: t } = page;
  return [
    { value: t.merged, label: 'merged' },
    // With no PR merged or closed, there is no rate to show yet.
    ...(t.mergeRate === null ? [] : [{ value: formatRate(t.mergeRate), label: 'merge rate' }]),
    { value: t.opened, label: 'opened' },
    { value: t.issues, label: t.issues === 1 ? 'issue worked' : 'issues worked' },
    { value: t.projects, label: t.projects === 1 ? 'project helped' : 'projects helped' },
    ...(t.tokens === null ? [] : [{ value: formatTokens(t.tokens), label: 'tokens est.' }]),
    ...(t.ownMerged === 0 ? [] : [{ value: t.ownMerged, label: 'merged on their own projects' }]),
  ];
}

function Person({ page }: { page: PersonPage }) {
  const lines = useWallFeed(`/@${page.login}/live.ndjson`, page.live, WALL_LINES);
  return (
    <>
      <header className="person-head">
        <span className="avatar person-avatar" aria-hidden="true">
          {page.login.charAt(0).toUpperCase()}
        </span>
        <div className="person-who">
          <h1 className="person-title">@{page.login}</h1>
          <p className="person-meta">
            {page.agents.map((agent) => (
              <Chip key={agent}>{agent}</Chip>
            ))}
            <span className="mono small faint">
              since <time dateTime={page.joinedAt}>{month(page.joinedAt)}</time>
            </span>
          </p>
        </div>
        <a className="mono small person-github" href={`https://github.com/${page.login}`}>
          on github ↗
        </a>
      </header>

      <div className="person-stats">
        <StatLine stats={totals(page)} />
      </div>

      <section className="person-activity" aria-label={`Activity over the last ${String(page.activity.weeks)} weeks`}>
        <div className="person-activity__scroll">
          <TokenField squares={page.activity.squares} cols={page.activity.weeks} />
        </div>
        <p className="person-legend">
          <span>{page.activity.weeks} weeks. One column per week.</span>
          <span className="person-legend__scale">
            less <i className="token-field__square" data-level="0" /> <i className="token-field__square" data-level="1" />{' '}
            <i className="token-field__square" data-level="2" /> <i className="token-field__square" data-level="4" /> more
          </span>
          <span className="person-legend__scale">
            <i className="token-field__square" data-level="merged" /> merged
          </span>
        </p>
      </section>

      <div className="person-split">
        <div className="person-main">
          <section className="person-section">
            <RailHead>
              <Marker as="h2" variant="live" count={page.working.length > 0 ? page.working.length : undefined}>
                working now
              </Marker>
            </RailHead>
            {page.working.length === 0 ? (
              <p className="person-note">Nothing right now.</p>
            ) : (
              <ul className="person-rows">
                {page.working.map((row) => (
                  <Work key={`${row.issue}:${row.claimedAt}`} row={row} />
                ))}
              </ul>
            )}
          </section>

          <section className="person-section">
            <RailHead>
              <Marker as="h2">history</Marker>
            </RailHead>
            {page.history.length === 0 ? (
              <p className="person-note">No earlier work yet.</p>
            ) : (
              <ul className="person-rows">
                {page.history.map((row) => (
                  <Work key={`${row.issue}:${row.claimedAt}`} row={row} />
                ))}
              </ul>
            )}
            {page.history.length > 0 && <p className="person-note">Newest claims first.</p>}
          </section>
        </div>

        <aside className="person-aside" aria-label={`About @${page.login}`}>
          <section className="person-section">
            <RailHead>
              <Marker as="h2" variant="live">
                live
              </Marker>
            </RailHead>
            <Wall lines={lines} />
            {lines.length === 0 && (
              <p className="person-note">
                {page.live === null
                  ? "The live feed is unavailable right now."
                  : 'Quiet right now.'}
              </p>
            )}
            <p className="person-note">
              <a className="person-stream" href={`/@${page.login}/live.txt`}>
                curl -N {page.site}/@{page.login}/live.txt
              </a>
            </p>
          </section>

          <section className="person-section">
            <RailHead>
              <Marker as="h2">helped</Marker>
            </RailHead>
            {page.helped.length === 0 ? (
              <p className="person-note">No PRs merged yet.</p>
            ) : (
              <ol className="person-helped">
                {page.helped.map((project) => (
                  <li key={project.repo}>
                    <a className="mono" href={`/${project.repo}`}>
                      {project.repo}
                    </a>
                    <span className="person-helped__n">{project.merged.toLocaleString('en-US')}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="person-section">
            <RailHead>
              <Marker as="h2">maintains</Marker>
            </RailHead>
            {page.maintains.length === 0 ? (
              <>
                <p className="person-note">Nothing on Good First Token yet.</p>
                <Prompt small copy="/goodfirsttoken:maintain" copyName="Copy the maintain command">
                  /goodfirsttoken:maintain
                </Prompt>
              </>
            ) : (
              <ul className="person-helped">
                {page.maintains.map((repo) => (
                  <li key={repo}>
                    <a className="mono" href={`/${repo}`}>
                      {repo}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

const STATUS: Record<WorkStatus, { label: string; variant?: ChipVariant }> = {
  working: { label: 'working', variant: 'live' },
  paused: { label: 'paused' },
  submitted: { label: 'submitted', variant: 'submitted' },
  pr_open: { label: 'PR open', variant: 'opened' },
  merged: { label: 'merged', variant: 'merged' },
  pr_closed: { label: 'PR closed' },
  released: { label: 'released' },
  expired: { label: 'expired' },
};

function Work({ row }: { row: WorkRow }) {
  const status = STATUS[row.status];
  const ref = `${row.repo}#${String(row.number)}`;
  return (
    <li className="person-row">
      <span className="person-row__title">
        <a href={`/${row.repo}/issues/${String(row.number)}`}>{row.title ?? ref}</a>
      </span>
      <span className="person-row__meta">
        {row.title !== null && <span className="mono">{ref}</span>}
        {row.pr && (
          <a className="mono" href={prUrl(row.pr)}>
            PR {refName(row.pr, row.repo)}
          </a>
        )}
        <Chip>{row.agent}</Chip>
        {row.ownProject && <Chip variant="tint">own project</Chip>}
        <time className="faint" dateTime={row.claimedAt}>
          {day(row.claimedAt)}
        </time>
      </span>
      <span className="person-row__side">
        <Chip variant={status.variant}>{status.label}</Chip>
      </span>
    </li>
  );
}
