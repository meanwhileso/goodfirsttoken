import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { Footer } from '../components/Footer';
import { Tabs } from '../components/Tabs';
import type { Tally } from '../db';
import { getLeaderboard, type Board, type LeaderboardPage } from '../leaderboard/data';
import { formatRate, formatTokens } from '../leaderboard/format';
import leaderboardCss from '../styles/leaderboard-page.css?url';
import { routeHead } from '../readable/head';

// The leaderboard (brand/brief-website.md): people ranked by the PRs
// maintainers merged, this week and of all time, and the merge rate of each
// agent and each project. The rules are in docs/how-it-works.md, under The
// leaderboard.
export const Route = createFileRoute('/leaderboard')({
  loader: () => getLeaderboard(),
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: `Leaderboard · ${productName}`,
        description:
          'Who helped get pull requests merged. Rankings by person, agent, and project.',
        path: '/leaderboard',
      },
      [{ rel: 'stylesheet', href: leaderboardCss }],
    ),
  component: Leaderboard,
});

function Leaderboard() {
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav current="leaderboard" />
      <main className="wrap board">
        <h1 className="display board-title">
          Ranked by merged PRs
        </h1>
        {page.state === 'ready' ? (
          <Views page={page} />
        ) : (
          <p className="board-note">The leaderboard can&apos;t be read right now. Try again in a moment.</p>
        )}
      </main>
      <Footer />
    </>
  );
}

function Views({ page }: { page: LeaderboardPage }) {
  return (
    <div className="board-views">
      <Tabs
        label="Leaderboard view"
        panelClassName="board-panel"
        tabs={[
          {
            label: 'this week',
            panel: (
              <>
                <People board={page.week} empty="No PRs this week yet. The week started Monday." />
                <p className="board-note">
                  The week starts Monday at 00:00 UTC. Each PR counts toward opened, merged, or closed in the week that
                  happened. Merge rate is merged ÷ (merged + closed). Token counts are estimates from agents.
                  PRs on the claimant's own project count separately and do not affect their rank.
                </p>
              </>
            ),
          },
          { label: 'all time', panel: <People board={page.allTime} empty="No PRs yet." /> },
          { label: 'by agent', panel: <Agents board={page.agents} /> },
          { label: 'by project', panel: <Projects board={page.projects} /> },
        ]}
      />
    </div>
  );
}

/** How many are shown of how many, when the view has more than it shows. */
function More({ board }: { board: Board }) {
  if (board.total <= board.rows.length) return null;
  return (
    <p className="board-note">
      The first {board.rows.length.toLocaleString('en-US')} of {board.total.toLocaleString('en-US')}.
    </p>
  );
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The small line under a name: every count but the one it ranks by. */
function details(row: Tally, extra: string[] = []): string {
  return [
    ...extra,
    count(row.opened, 'opened', 'opened'),
    `merge rate ${formatRate(row.mergeRate)}`,
    count(row.issues, 'issue worked', 'issues worked'),
    ...(row.tokens === null ? [] : [`${formatTokens(row.tokens)} tokens est.`]),
  ].join(' · ');
}

function Own({ row }: { row: Tally }) {
  return (
    <span className="board-own" title="PRs on the claimant's own project count separately from their rank.">
      {row.ownMerged.toLocaleString('en-US')}
      <small>own project</small>
    </span>
  );
}

function People({ board, empty }: { board: Board; empty: string }) {
  if (board.rows.length === 0) return <p className="board-note">{empty}</p>;
  return (
    <>
      <div className="board-head" aria-hidden="true">
        <span>merged</span>
        <span>own project</span>
      </div>
      <ol className="ranks board-ranks">
        {board.rows.map((row, i) => (
          <li key={row.key}>
            <span className="ranks__n">{i + 1}</span>
            <span className="ranks__who">
              <a href={`/@${row.login ?? ''}`}>@{row.login}</a>
              {row.agent !== null && <small className="ranks__agent">{row.agent}</small>}
              <small className="board-detail">
                {details(row, [count(row.projects, 'project helped', 'projects helped')])}
              </small>
            </span>
            <span className="ranks__score board-score">
              {row.merged.toLocaleString('en-US')}
              <small>merged</small>
            </span>
            <Own row={row} />
          </li>
        ))}
      </ol>
      <More board={board} />
    </>
  );
}

function Agents({ board }: { board: Board }) {
  return (
    <>
      <div className="board-bars">
        {board.rows.map((row) => (
          <div className="board-bar" key={row.key}>
            <span className="mono board-bar__name">{row.key}</span>
            <span className="board-bar__track" aria-hidden="true">
              <span className="board-bar__fill" style={{ width: `${String(Math.round((row.mergeRate ?? 0) * 100))}%` }} />
            </span>
            <span className="board-bar__value">
              {formatRate(row.mergeRate)} · {count(row.merged, 'merged', 'merged')}
            </span>
          </div>
        ))}
      </div>
      <More board={board} />
      <p className="board-note">
        All-time merge rate and merged PRs for each agent. The claim records which agent gets credit.
        PRs on the claimant's own project are excluded.
      </p>
    </>
  );
}

function Projects({ board }: { board: Board }) {
  if (board.rows.length === 0) return <p className="board-note">No PRs merged on a project yet.</p>;
  return (
    <>
      <div className="board-head" aria-hidden="true">
        <span>merged</span>
        <span>own project</span>
      </div>
      <ol className="ranks board-ranks">
        {board.rows.map((row, i) => (
          <li key={row.key}>
            <span className="ranks__n">{i + 1}</span>
            <span className="ranks__who">
              <a className="mono" href={`/${row.key}`}>
                {row.key}
              </a>
              <small className="board-detail">{details(row, [count(row.people, 'person helped', 'people helped')])}</small>
            </span>
            <span className="ranks__score board-score">
              {row.merged.toLocaleString('en-US')}
              <small>merged</small>
            </span>
            <Own row={row} />
          </li>
        ))}
      </ol>
      <More board={board} />
      <p className="board-note">
        All-time totals for listed projects. The own project column counts PRs from their maintainers.
      </p>
    </>
  );
}
