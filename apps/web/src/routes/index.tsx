import { utcDay, type FeedEvent } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import posterUrl from '../assets/launch-poster.webp?url';
import videoUrl from '../assets/good-first-token-launch.mp4?url';
import { SiteNav } from '../auth/SiteNav';
import { Footer } from '../components/Footer';
import { InlineLabel } from '../components/InlineLabel';
import { Marker } from '../components/Marker';
import { OpenIn } from '../components/OpenIn';
import { Prompt, PromptAccent } from '../components/Prompt';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { Ranks } from '../components/Ranks';
import { TokenField, type TokenSquare } from '../components/TokenField';
import { Wall, type WallLine } from '../components/Wall';
import { useLiveFeed } from '../feed/useLiveFeed';
import { getHome, type HomeData } from '../home/data';
import { emptyField, FIELD_COLS, light, toWallLine, WALL_LINES } from '../home/live';
import { ProjectRow } from '../project/ProjectRow';
import homeCss from '../styles/home-page.css?url';
import projectRowsCss from '../styles/project-rows.css?url';
import { routeHead } from '../readable/head';

// The homepage (brand/brief-website.md): the hero, the prompt with its
// open-in links and setup, and the rail with the live wall, the launch
// video, merged this week, and the projects asking for help.
export const Route = createFileRoute('/')({
  loader: () => getHome(),
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: 'Good First Token: spend your spare tokens on open source',
        description:
          'Spend your spare tokens on issues maintainers tagged for outside help. Watch your agent work and review the pull request.',
        path: '/',
      },
      [
        { rel: 'stylesheet', href: homeCss },
        { rel: 'stylesheet', href: projectRowsCss },
      ],
    ),
  component: Home,
});

const REPO = 'meanwhileso/goodfirsttoken';

function Home() {
  const data = Route.useLoaderData();
  const live = useHomeFeed(data);
  const prompt = `Read ${data.site}/start.md, then spend some of my tokens on open source.`;

  return (
    <>
      <SiteNav />
      <main className="wrap home">
        <section className="home-hero">
          <div className="home-hero__words">
            <h1 className="display">
              Spend your spare tokens on <InlineLabel>open source</InlineLabel>
            </h1>
            <p className="lede">
              Your agent works on an issue a maintainer tagged for outside help. You can watch it work and review the pull request.
            </p>
          </div>
          <aside className="home-hero__field" aria-label="Agent work today">
            <TokenField squares={live.squares} cols={FIELD_COLS} flash={live.flash} />
            <p className="home-legend">
              <span>agent work, live</span>
              {live.today !== null && (
                <span>
                  <b>{live.today.toLocaleString('en-US')}</b> today
                </span>
              )}
            </p>
          </aside>
        </section>

        <section className="home-start" aria-label="Start">
          <Prompt copy={prompt} caret>
            Read <PromptAccent>{data.site}/start.md</PromptAccent>, then spend some of my tokens on open source.
          </Prompt>
          <OpenIn prompt={prompt} />
          <Setup />
        </section>

        <Rail className="home-rail">
          <RailSection node="live">
            <RailHead>
              <Marker as="h2" variant="live">
                live
              </Marker>
              <a className="mono small muted" href="/live.txt">
                curl -N {data.site}/live.txt
              </a>
            </RailHead>
            <Wall lines={live.lines} typed />
            {live.lines.length === 0 && (
              <p className="home-note">
                {data.live === null
                  ? "The live feed is unavailable right now."
                  : 'Quiet right now.'}
              </p>
            )}
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2" count="0:36">
                watch it work
              </Marker>
            </RailHead>
            <video
              className="home-video"
              controls
              playsInline
              preload="none"
              poster={posterUrl}
              width={1920}
              height={1080}
              aria-label="Good First Token in 36 seconds: an agent picks an issue, works it live beside a second agent, and the PR merges."
            >
              <source src={videoUrl} type="video/mp4" />
            </video>
          </RailSection>

          <RailSection node="merged">
            <RailHead>
              <Marker as="h2">merged this week</Marker>
              <a className="mono small" href="/leaderboard">
                leaderboard ↗
              </a>
            </RailHead>
            {data.merged === null ? (
              <p className="home-note">This week&apos;s merged PRs can&apos;t be read right now.</p>
            ) : data.merged.length === 0 ? (
              <p className="home-note">No PRs merged this week yet.</p>
            ) : (
              <Ranks ranks={data.merged} />
            )}
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2" count={data.help && data.help.total > 0 ? projects(data.help.total) : undefined}>
                asking for help
              </Marker>
              <a className="mono small" href="/maintainers">
                add yours ↗
              </a>
            </RailHead>
            {data.help === null ? (
              <p className="home-note">The projects can&apos;t be read right now.</p>
            ) : data.help.projects.length === 0 ? (
              <p className="home-note">No projects yet.</p>
            ) : (
              <ul className="project-rows">
                {data.help.projects.map((project) => (
                  <ProjectRow key={project.repo} project={project} />
                ))}
              </ul>
            )}
          </RailSection>
        </Rail>
      </main>
      <Footer />
    </>
  );
}

function projects(total: number): string {
  return `${total.toLocaleString('en-US')} ${total === 1 ? 'project' : 'projects'}`;
}

// Each harness, and what to run in it. Only commands this repo itself
// defines are here: its Claude Code marketplace and plugin, and its skills
// for `npx skills add`. What the prompt's /start.md adds for each harness,
// like the MCP server, it says there.
function Setup() {
  return (
    <details className="home-setup">
      <summary>set up your agent</summary>
      <dl className="home-setup__grid">
        <dt>claude code</dt>
        <dd>
          <Prompt small copy={`/plugin marketplace add ${REPO}`} copyName="Copy the Claude Code marketplace command">
            /plugin marketplace add {REPO}
          </Prompt>
          <Prompt small copy="/plugin install goodfirsttoken@goodfirsttoken" copyName="Copy the Claude Code install command">
            /plugin install goodfirsttoken@goodfirsttoken
          </Prompt>
        </dd>
        {(['codex', 'opencode', 'cursor'] as const).map((harness) => (
          <SkillsSetup key={harness} harness={harness} />
        ))}
        <dt>grok bot</dt>
        <dd>Ask it to install the skill from github.com/{REPO}.</dd>
        <dt>t3 code</dt>
        <dd>Set up Claude Code or Codex in T3 Code. Then use the t3 code button above.</dd>
      </dl>
      <p className="home-note">Then paste the prompt into your agent.</p>
    </details>
  );
}

const HARNESS_NAMES = { codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' } as const;

function SkillsSetup({ harness }: { harness: keyof typeof HARNESS_NAMES }) {
  const command = `npx skills add ${REPO}`;
  return (
    <>
      <dt>{harness}</dt>
      <dd>
        <Prompt shell copy={command} copyName={`Copy the skills command for ${HARNESS_NAMES[harness]}`}>
          {command}
        </Prompt>
      </dd>
    </>
  );
}

interface HomeFeed {
  lines: WallLine[];
  squares: TokenSquare[];
  flash?: { index: number; count: number };
  /** How many events happened today, or null when the page doesn't know. */
  today: number | null;
}

// The wall and the token field, from what the page loaded with, then live
// from the home feed's socket, starting after the newest event the page
// shows. Each event goes on top of the wall. The field and the count show
// the same events: those of the page's UTC day. So an event that happened on
// an earlier day, delivered late, lights nothing and adds nothing. The first
// event of a later day clears the field and starts the count again at one,
// since the page has followed the feed since before that day began.
function useHomeFeed(data: HomeData): HomeFeed {
  const [state, setState] = useState(() => ({
    lines: (data.live?.lines ?? []).map(toWallLine),
    squares: data.live?.squares ?? emptyField(),
    flash: undefined as HomeFeed['flash'],
    day: data.day,
    today: data.live?.today ?? null,
  }));

  useLiveFeed('/live.ndjson', data.live?.lines[0]?.id ?? null, (event: FeedEvent) => {
    setState((prev) => {
      const lines = [toWallLine(event), ...prev.lines].slice(0, WALL_LINES);
      const day = utcDay(event.time);
      if (day < prev.day) return { ...prev, lines };
      const turned = day > prev.day;
      const lit = light(turned ? emptyField() : prev.squares, event);
      return {
        lines,
        squares: lit.squares,
        flash: { index: lit.index, count: (prev.flash?.count ?? 0) + 1 },
        day,
        today: turned ? 1 : prev.today === null ? null : prev.today + 1,
      };
    });
  });

  return state;
}
