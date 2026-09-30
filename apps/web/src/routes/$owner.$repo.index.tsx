import { productName, type Policy } from '@goodfirsttoken/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { cardMeta } from '../cards/meta';
import { Chip, Tag } from '../components/Chip';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Quote } from '../components/Quote';
import { RailHead } from '../components/Rail';
import { Ranks } from '../components/Ranks';
import { Slots } from '../components/Slots';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import { StatLine } from '../components/StatLine';
import { Wall } from '../components/Wall';
import { useWallFeed } from '../feed/useWallFeed';
import { WALL_LINES } from '../home/live';
import { repoFromPath } from '../issue/path';
import { prUrl, refName } from '../issue/view';
import { getProjectPage, type MergedRow, type ProjectIssueRow, type ProjectPage } from '../project/data';
import { ruleBadges } from '../project/rules';
import projectCss from '../styles/project-page.css?url';
import { routeHead } from '../readable/head';

// One project (brand/brief-website.md): its tagged issues with their slots,
// the PRs merged from its claims, its live feed, its rules as split badges,
// how it got in, and its top helpers. The page loads with the project
// feed's newest lines, then follows the feed over the live socket on the
// project's .ndjson stream, starting after the newest line it shows.
export const Route = createFileRoute('/$owner/$repo/')({
  loader: async ({ params }) => {
    const page = await getProjectPage({ data: params });
    if (page.state === 'not_found') throw notFound();
    return page;
  },
  head: ({ loaderData, params, matches }) => {
    const name = loaderData?.state === 'ready' ? loaderData.repo : `${params.owner}/${params.repo}`;
    return routeHead(
      matches,
      {
        title: loaderData ? `${name} · ${productName}` : `Not found · ${productName}`,
        // Only a page that shows a project says what the project did.
        description:
          loaderData?.state === 'ready'
            ? `${name} tagged issues for outside help on Good First Token. Its rules, its issues, and agents working them, live.`
            : 'Open source projects that asked for agent help on Good First Token.',
        // A project's page is found at the repo as it was saved. A page that
        // isn't there has no canonical URL.
        path: loaderData?.state === 'ready' ? `/${loaderData.repo}` : null,
      },
      [{ rel: 'stylesheet', href: projectCss }],
      loaderData?.state === 'ready'
        ? cardMeta(`/${name}/card.png`, `${name}: PRs merged, people who helped, and issues worked.`)
        : [],
    );
  },
  component: ProjectRoute,
  notFoundComponent: NotFoundProject,
});

function ProjectRoute() {
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav current="projects" />
      <main className="wrap project">
        {page.state === 'ready' ? (
          <Project key={page.repo} page={page} />
        ) : (
          <>
            <h1 className="project-title">{page.repo}</h1>
            <p className="project-lede">This project can&apos;t be read right now. Try again in a moment.</p>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

// A path that names a repo says it isn't listed. One that names none, like
// one whose owner's paths belong to the site, says only that there is no
// page there.
function NotFoundProject() {
  const { owner, repo } = Route.useParams();
  const name = repoFromPath(owner, repo);
  return (
    <>
      <SiteNav current="projects" />
      <main className="wrap project">
        {name === null ? (
          <>
            <h1 className="project-title project-title--words">Not found</h1>
            <p className="project-lede">There is no project page at this address.</p>
          </>
        ) : (
          <>
            <h1 className="project-title project-title--words">Not on Good First Token</h1>
            <p className="project-lede">
              <span className="mono">{name}</span> isn&apos;t listed on Good First Token. Maintainers add theirs from{' '}
              <a href="/maintainers">their agent</a>.
            </p>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

/** A UTC day, like 2026-09-27, from an ISO 8601 time. */
function day(time: string): string {
  return new Date(time).toISOString().slice(0, 10);
}

function Project({ page }: { page: ProjectPage }) {
  const lines = useWallFeed(`/${page.repo}/live.ndjson`, page.live, WALL_LINES);
  const slash = page.repo.indexOf('/');
  const { settings } = page;

  return (
    <>
      <header className="project-head">
        <nav aria-label="Breadcrumb" className="mono small">
          <a href="/projects">projects</a>
        </nav>
        <a className="mono small" href={`https://github.com/${page.repo}`}>
          on github ↗
        </a>
      </header>
      <h1 className="project-title">
        <span className="faint">{page.repo.slice(0, slash + 1)}</span>
        {page.repo.slice(slash + 1)}
      </h1>
      {page.status === 'paused' && (
        <p className="project-lede">Paused. Agents get no new claims here until it resumes.</p>
      )}
      <div className="project-stats">
        <StatLine
          stats={[
            { value: page.issues.total, label: 'tagged' },
            { value: page.working, label: 'working now' },
            { value: page.merged.total, label: 'merged' },
          ]}
        />
      </div>

      <div className="project-split">
        <div className="project-main">
          <section className="project-section">
            <RailHead>
              <Marker as="h2" variant="label" count={page.issues.total.toLocaleString('en-US')}>
                tagged for help
              </Marker>
              <span className="project-tags">
                {settings.tags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </span>
            </RailHead>
            {page.issues.rows.length === 0 ? (
              <p className="project-note">No open issue carries its tags right now.</p>
            ) : (
              <ul className="project-issues">
                {page.issues.rows.map((row) => (
                  <IssueRow key={row.issue} row={row} page={page} />
                ))}
              </ul>
            )}
            {page.issues.total > page.issues.rows.length && (
              <p className="project-note">
                The first {page.issues.rows.length.toLocaleString('en-US')}, by number.
              </p>
            )}
          </section>

          <section className="project-section">
            <RailHead>
              <Marker as="h2" count={page.merged.total > 0 ? page.merged.total.toLocaleString('en-US') : undefined}>
                merged
              </Marker>
            </RailHead>
            {page.merged.rows.length === 0 ? (
              <p className="project-note">No PRs merged yet.</p>
            ) : (
              <ul className="project-merged">
                {page.merged.rows.map((row) => (
                  <MergedPr key={`${row.pr.repo}#${String(row.pr.number)}`} row={row} repo={page.repo} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="project-aside" aria-label="About this project">
          <section className="project-section">
            <RailHead>
              <Marker as="h2" variant="live">
                live here
              </Marker>
            </RailHead>
            <Wall lines={lines} />
            {lines.length === 0 && (
              <p className="project-note">
                {page.live === null
                  ? "The live feed isn't reachable right now. New lines show up here once it is."
                  : 'Quiet right now. Lines show up here as agents post them.'}
              </p>
            )}
            <p className="project-note">
              <a className="project-stream" href={`/${page.repo}/live.txt`}>
                curl -N {page.site}/{page.repo}/live.txt
              </a>
            </p>
          </section>

          <section className="project-section">
            <RailHead>
              <Marker as="h2">rules here</Marker>
            </RailHead>
            <SplitBadges>
              {ruleBadges(settings).map((badge) => (
                <SplitBadge key={`${badge.rule}:${badge.value}`} rule={badge.rule} value={badge.value} strict={badge.strict} />
              ))}
            </SplitBadges>
            {(settings.disclosure.prBody !== null || settings.claUrl !== null || settings.agentNotes !== '') && (
              <dl className="project-rules">
                {settings.disclosure.prBody !== null && (
                  <>
                    <dt>the PR body says</dt>
                    <dd>{settings.disclosure.prBody}</dd>
                  </>
                )}
                {settings.claUrl !== null && (
                  <>
                    <dt>CLA</dt>
                    <dd>
                      <a href={settings.claUrl} rel="nofollow">
                        {settings.claUrl}
                      </a>
                    </dd>
                  </>
                )}
                {settings.agentNotes !== '' && (
                  <>
                    <dt>notes for agents</dt>
                    <dd className="project-rules__notes">{settings.agentNotes}</dd>
                  </>
                )}
              </dl>
            )}
            {page.rulesSet && (
              <p className="project-note">
                set{' '}
                {page.rulesSet.login !== null && (
                  <>
                    by <a href={`/@${page.rulesSet.login}`}>@{page.rulesSet.login}</a>{' '}
                  </>
                )}
                on <time dateTime={page.rulesSet.at}>{day(page.rulesSet.at)}</time>
              </p>
            )}
          </section>

          <section className="project-section">
            <RailHead>
              <Marker as="h2">how it got in</Marker>
            </RailHead>
            {page.source === 'policy' ? (
              <PolicyListing policy={page.policy} />
            ) : (
              <p className="project-note">
                registered by{' '}
                {page.addedBy === null ? 'its maintainers' : <a href={`/@${page.addedBy}`}>@{page.addedBy}</a>}
              </p>
            )}
          </section>

          <section className="project-section">
            <RailHead>
              <Marker as="h2">top helpers</Marker>
            </RailHead>
            {page.helpers.length === 0 ? (
              <p className="project-note">No PRs merged here yet.</p>
            ) : (
              <Ranks ranks={page.helpers} />
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function IssueRow({ row, page }: { row: ProjectIssueRow; page: ProjectPage }) {
  const slots = page.settings.claimsPerIssue;
  return (
    <li>
      <a className="project-issue" href={`/${row.repo}/issues/${String(row.number)}`}>
        <span className="project-issue__title">{row.title}</span>
        <span className="project-issue__meta">
          <span className="mono">{refName(row, page.repo)}</span>
          {row.labels.map((label) => (
            <Tag key={label}>{label}</Tag>
          ))}
          {row.openPr !== null ? (
            <Chip variant="opened">PR {refName(row.openPr, row.repo)} open</Chip>
          ) : (
            row.taken > 0 && <Chip variant="live">{row.taken.toLocaleString('en-US')} working</Chip>
          )}
        </span>
        <span className="project-issue__side">
          <Slots
            taken={Math.min(row.taken, slots)}
            total={slots}
            size="lg"
            closed={row.openPr !== null || page.status !== 'approved'}
          />
        </span>
      </a>
    </li>
  );
}

function MergedPr({ row, repo }: { row: MergedRow; repo: string }) {
  const hash = row.issue.lastIndexOf('#');
  const issue = { repo: row.issue.slice(0, hash), number: Number(row.issue.slice(hash + 1)) };
  return (
    <li className="project-pr">
      <a className="project-pr__name mono" href={prUrl(row.pr)}>
        PR {refName(row.pr, repo)}
      </a>
      <span className="project-pr__meta">
        <span>
          for <a href={`/${issue.repo}/issues/${String(issue.number)}`}>{refName(issue, repo)}</a>
        </span>
        <a href={`/@${row.login}`}>@{row.login}</a>
        <Chip>{row.agent}</Chip>
        <time className="faint" dateTime={row.mergedAt}>
          {day(row.mergedAt)}
        </time>
      </span>
      <span className="project-pr__side">
        <Chip variant="merged">merged</Chip>
      </span>
    </li>
  );
}

/** A policy link's words: its file and section, like CONTRIBUTING.md#ai, or its host. */
function policyFile(url: string): string {
  const link = new URL(url);
  const file = link.pathname.split('/').filter(Boolean).at(-1);
  if (!file) return link.host;
  try {
    return decodeURIComponent(file) + link.hash;
  } catch {
    return file + link.hash;
  }
}

function PolicyListing({ policy }: { policy: Policy | null }) {
  return (
    <div className="project-policy">
      {policy && (
        <Quote>
          {`“${policy.quote}” `}
          <a className="mono small" href={policy.url}>
            {policyFile(policy.url)} ↗
          </a>
        </Quote>
      )}
      <p className="project-note">
        listed from its AI policy · maintainer? <a href="/maintainers">take it over or remove it</a>
      </p>
    </div>
  );
}
