import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import markUrl from '../assets/mark.svg?url';
import { SiteNav } from '../auth/SiteNav';
import { Button, ButtonLink } from '../components/Button';
import { Chip, Tag } from '../components/Chip';
import { FilterChips } from '../components/FilterChips';
import { Footer } from '../components/Footer';
import { InlineLabel } from '../components/InlineLabel';
import { LogoChip } from '../components/LogoChip';
import { Marker } from '../components/Marker';
import { Nav } from '../components/Nav';
import { OpenIn } from '../components/OpenIn';
import { Prompt, PromptAccent } from '../components/Prompt';
import { Quote } from '../components/Quote';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { Ranks } from '../components/Ranks';
import { SlotRing } from '../components/SlotRing';
import { Slots } from '../components/Slots';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import { StatLine } from '../components/StatLine';
import { Tabs } from '../components/Tabs';
import { TokenField, type TokenSquare } from '../components/TokenField';
import { Wall, type WallLine } from '../components/Wall';
import { SAMPLE_COMMAND, SAMPLE_EVENTS, SAMPLE_PROMPT, SAMPLE_REPO, type SampleEvent } from '../design/samples';
import designCss from '../styles/design-page.css?url';
import { routeHead } from '../readable/head';

// The living design system: every component, rendered with sample data.
export const Route = createFileRoute('/design')({
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: `Design system · ${productName}`,
        description: "Components and sample data for Good First Token.",
        path: '/design',
      },
      [{ rel: 'stylesheet', href: designCss }],
    ),
  component: DesignSystem,
});

const WALL_SIZE = 4;
const NEW_LINE_EVERY_MS = 3800;
// Sample times run on their own clock from here, so the page renders the
// same on the server and in every browser.
const START_SECONDS = 14 * 3600 + 2 * 60 + 51;

function sampleTime(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function event(n: number): SampleEvent {
  const sample = SAMPLE_EVENTS[n % SAMPLE_EVENTS.length];
  if (!sample) throw new Error('There are no sample events.');
  return sample;
}

// The wall starts with the last few events, newest first, 17 seconds apart.
const FIRST_LINES: readonly WallLine[] = Array.from({ length: WALL_SIZE }, (_, n) => ({
  ...event(SAMPLE_EVENTS.length - 1 - n),
  id: `first-${String(n)}`,
  time: sampleTime(START_SECONDS - n * 17),
}));

// A seeded generator, so the token field looks the same on every load.
function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
}

const FIELD_COLS = 14;
const FIELD_ROWS = 6;

function firstSquares(): TokenSquare[] {
  const rand = seeded(7);
  return Array.from({ length: FIELD_COLS * FIELD_ROWS }, () => {
    const r = rand();
    return r > 0.93 ? 4 : r > 0.8 ? 3 : r > 0.6 ? 2 : r > 0.38 ? 1 : 0;
  });
}

function brighter(square: TokenSquare): TokenSquare {
  return square === 'merged' ? square : (Math.min(4, square + 2) as TokenSquare);
}

// Plays sample events: a new line on the wall every few seconds, and a
// square in the token field lighting up for each one.
function useSampleFeed() {
  const [lines, setLines] = useState(FIRST_LINES);
  const [squares, setSquares] = useState(firstSquares);
  const [flash, setFlash] = useState<{ index: number; count: number }>();

  useEffect(() => {
    const pick = seeded(42);
    let n = 0;
    const timer = setInterval(() => {
      const count = n;
      n += 1;
      const line: WallLine = {
        ...event(count),
        id: `live-${String(count)}`,
        time: sampleTime(START_SECONDS + (count + 1) * 4),
      };
      const index = Math.floor(pick() * FIELD_COLS * FIELD_ROWS);
      setLines((prev) => [line, ...prev].slice(0, WALL_SIZE));
      setSquares((prev) => prev.map((square, i) => (i === index ? brighter(square) : square)));
      setFlash({ index, count });
    }, NEW_LINE_EVERY_MS);
    return () => { clearInterval(timer); };
  }, []);

  return { lines, squares, flash };
}

const SWATCHES = [
  'paper', 'ink', 'label', 'accent', 'accent-ink', 'accent-tint', 'metadata', 'metadata-ink', 'merged',
  'attention', 'danger', 'text-muted', 'text-faint', 'line', 'code-accent',
] as const;

const noChanges = () => () => undefined;

// Reads a token's value from the stylesheet, so the page shows what the CSS
// says. It is empty in the server render and fills in on load.
function Swatch({ token }: { token: string }) {
  const value = useSyncExternalStore(
    noChanges,
    () => getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim().toUpperCase(),
    () => '',
  );
  return (
    <div className="swatch">
      <span className="swatch__color" style={{ background: `var(--${token})` }} />
      {token} <span className="faint">{value}</span>
    </div>
  );
}

// One grid row: the section's name on the left, and its one child, the
// example, on the right.
function Section({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <section className="ds">
      <h2>
        {name}
        {note && <small>{note}</small>}
      </h2>
      {children}
    </section>
  );
}

function DesignSystem() {
  const { lines, squares, flash } = useSampleFeed();
  const [period, setPeriod] = useState<'this week' | 'all time'>('this week');

  return (
    <>
      <SiteNav />
      <main className="wrap ds-main">
        <h1 className="display ds-title">
          Design system
        </h1>
        <p className="lede ds-lede">
          Components and sample data from <span className="mono">brand/design.md</span>.
        </p>

        <Section name="logo">
          <div className="cluster" style={{ gap: 24 }}>
            <LogoChip size="lg" />
            <img src={markUrl} width="64" height="64" alt="Good First Token mark" />
          </div>
        </Section>

        <Section name="display" note="one purple label in a marketing headline">
          <p className="display ds-headline">
            Spend your spare tokens on <InlineLabel>open source</InlineLabel>
          </p>
        </Section>

        <Section name="markers" note="a label names each section">
          <div className="cluster">
            <Marker variant="live" count="6 agents">
              live
            </Marker>
            <Marker>merged this week</Marker>
            <Marker count={4}>
              tagged for help
            </Marker>
          </div>
        </Section>

        <Section name="badges" note="a rule and its value">
          <SplitBadges>
            <SplitBadge rule="PRs" value="automatic" />
            <SplitBadge rule="PRs" value="reviewed" strict />
            <SplitBadge rule="disclose" value="Assisted-by" />
            <SplitBadge rule="slots" value="3" />
          </SplitBadges>
        </Section>

        <Section name="slots" note="claim counts and open slots">
          <div className="stack" style={{ gap: 24 }}>
            <div className="cluster" style={{ gap: 28 }}>
              <Slots taken={2} size="lg" />
              <Slots taken={1} />
              <Slots taken={2} size="lg" closed />
            </div>
            <div className="cluster" style={{ gap: 28 }}>
              <SlotRing />
              <SlotRing closed />
            </div>
          </div>
        </Section>

        <Section name="labels" note="project tags keep their own GitHub color">
          <div className="cluster">
            <Tag color="7057FF">goodfirsttoken</Tag>
            <Tag color="008672">help wanted</Tag>
            <Tag color="E244C0">ready</Tag>
            <Chip>claude-code</Chip>
            <Chip variant="live">working</Chip>
            <Chip variant="submitted">submitted</Chip>
            <Chip variant="opened">PR #57 opened</Chip>
            <Chip variant="merged">merged</Chip>
            <Chip variant="tough">tough</Chip>
            <Chip variant="tint">own project</Chip>
          </div>
        </Section>

        <Section name="numbers" note="stats read as a sentence">
          <StatLine
            stats={[
              { value: 3, label: 'tagged' },
              { value: 2, label: 'working now' },
              { value: 14, label: 'merged' },
            ]}
          />
        </Section>

        <Section name="prompt" note="copyable commands">
          <div className="stack">
            <Prompt copy={SAMPLE_PROMPT} caret>
              Read <PromptAccent>goodfirsttoken.org/start.md</PromptAccent>, then spend some of my tokens on open
              source.
            </Prompt>
            <Prompt copy={SAMPLE_COMMAND.copied} shell>
              {SAMPLE_COMMAND.shown}
            </Prompt>
            <OpenIn prompt={SAMPLE_PROMPT} />
          </div>
        </Section>

        <Section name="wall" note="older lines fade">
          <Wall lines={lines} typed />
        </Section>

        <Section name="token field" note="each square is agent work">
          <div className="ds-token-field">
            <TokenField squares={squares} cols={FIELD_COLS} flash={flash} />
          </div>
        </Section>

        <Section name="rail" note="sections along a timeline">
          <Rail className="ds-rail">
            <RailSection node="live">
              <RailHead>
                <Marker variant="live">live</Marker>
              </RailHead>
            </RailSection>
            <RailSection>
              <RailHead>
                <Marker>agent demo</Marker>
              </RailHead>
            </RailSection>
            <RailSection node="merged">
              <RailHead>
                <Marker>merged this week</Marker>
              </RailHead>
            </RailSection>
          </Rail>
        </Section>

        <Section name="ranks">
          <div className="ds-narrow">
            <Ranks
              ranks={[
                { login: 'priya', agent: 'claude-code', score: 10 },
                { login: 'kenji', agent: 'codex', score: 7 },
              ]}
            />
          </div>
        </Section>

        <Section name="project listing" note="how a project was listed">
          <div className="stack ds-narrow" style={{ gap: 28 }}>
            <span className="mono small faint">
              registered by <a href="/@octo-maintainer">@octo-maintainer</a>, who set these
            </span>
            <div className="stack" style={{ gap: 10 }}>
              <Quote>
                &ldquo;AI-assisted and agent-written pull requests are welcome here:&rdquo;{' '}
                <a className="mono small" href={`https://github.com/${SAMPLE_REPO}/blob/main/CONTRIBUTING.md`}>
                  CONTRIBUTING.md ↗
                </a>
              </Quote>
              <span className="mono small faint">
                listed from its AI policy · maintainers can <a href="/maintainers">take it over</a>
              </span>
            </div>
          </div>
        </Section>

        <Section name="buttons">
          <div className="cluster">
            <Button variant="primary">Open PR</Button>
            <Button>Read it</Button>
            <Button variant="danger">Disconnect</Button>
            <Button disabled>Open PR</Button>
            <ButtonLink href="/maintainers" size="sm">
              Get listed
            </ButtonLink>
            <FilterChips
              label="Show merged PRs from"
              options={['this week', 'all time'] as const}
              value={period}
              onChange={setPeriod}
            />
          </div>
        </Section>

        <Section name="tabs" note="chips that pick a view">
          <Tabs
            label="Leaderboard view"
            panelClassName="ds-tab-panel"
            tabs={[
              {
                label: 'this week',
                panel: <Ranks ranks={[{ login: 'priya', agent: 'claude-code', score: 10 }, { login: 'kenji', agent: 'codex', score: 7 }]} />,
              },
              {
                label: 'all time',
                panel: <Ranks ranks={[{ login: 'kenji', agent: 'codex', score: 31 }, { login: 'priya', agent: 'claude-code', score: 26 }]} />,
              },
              {
                label: 'by agent',
                panel: <Ranks ranks={[{ login: 'lena', agent: 'claude-code', score: 5 }, { login: 'sam', agent: 'opencode', score: 3 }]} />,
              },
            ]}
          />
        </Section>

        <Section name="nav" note="signed in, on their own page">
          <div className="stack" style={{ gap: 10 }}>
            <div className="ds-nav">
              <Nav current="me" user={{ login: 'priya' }} label="Signed-in nav example" />
            </div>
            <span className="mono small faint">it folds into its menu when it is 880px wide or narrower</span>
          </div>
        </Section>

        <Section name="color">
          <div className="swatches">
            {SWATCHES.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </div>
        </Section>

        <Section name="rules">
          <ul className="stack ds-rules" style={{ gap: 10 }}>
            <li>Use a marker to name each section.</li>
            <li>Put any explanation at the bottom of the section in mono.</li>
            <li>Hairlines group content. Save cards for real repeating units.</li>
            <li>Purple marks the brand. Blue marks links, slots, and activity. Green is live and merged.</li>
            <li>Submitted and PR-open states use the blue tint. Agent names, interests, and rule values stay neutral.</li>
            <li>Section markers stay neutral. Utility page titles use ink.</li>
            <li>Display type is huge and rare. Everything else is 14 to 20px.</li>
            <li>Animate live activity. Respect reduced motion.</li>
          </ul>
        </Section>

        <p className="mono small faint ds-note">Every name, number, and line on this page is sample data.</p>
      </main>
      <Footer />
    </>
  );
}
