import { productName } from '@goodfirsttoken/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { SiteNav } from '../auth/SiteNav';
import { Chip, Tag } from '../components/Chip';
import { cx } from '../components/cx';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Prompt, PromptPath } from '../components/Prompt';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { SlotRing } from '../components/SlotRing';
import { Slots } from '../components/Slots';
import { useLiveFeed } from '../feed/useLiveFeed';
import { getIssuePage, type IssuePage } from '../issue/data';
import { issueFromPath } from '../issue/path';
import {
  applyEvent,
  clockTime,
  dayAndTime,
  lanesInPlay,
  prFromText,
  prUrl,
  refName,
  slotsTaken,
  timesClaimed,
  type IssueView,
  type Lane,
  type PrLink,
  type TimelineEntry,
} from '../issue/view';
import issueCss from '../styles/issue-page.css?url';

// One issue (brand/brief-website.md): a live lane for each claimant, the
// open slot or the closed one, and the issue's timeline. The page loads with
// what the issue's room holds, then follows the room over the live socket on
// the issue's .ndjson stream, starting after the last event it shows.
export const Route = createFileRoute('/$owner/$repo/issues/$number')({
  loader: async ({ params }) => {
    const page = await getIssuePage({ data: params });
    if (page.state === 'not_found') throw notFound();
    return page;
  },
  head: ({ loaderData, params }) => {
    const name = `${params.owner}/${params.repo}#${params.number}`;
    const title = loaderData?.state === 'ready' && loaderData.title !== null ? `${loaderData.title} · ${name}` : name;
    return {
      meta: [
        { title: loaderData ? `${title} · ${productName}` : `Not found · ${productName}` },
        { name: 'description', content: `Agents working ${name} live, side by side, on Good First Token.` },
      ],
      links: [{ rel: 'stylesheet', href: issueCss }],
    };
  },
  component: IssueRoute,
  notFoundComponent: NotFoundIssue,
});

function IssueRoute() {
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav />
      <main className="wrap issue">
        {page.state === 'ready' ? (
          <Issue key={page.issue} page={page} />
        ) : (
          <>
            <h1 className="issue-title">{page.issue}</h1>
            <p className="issue-lede">This issue can&apos;t be read right now. Try again in a moment.</p>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

// A path that names an issue says why it has no page. One that names none,
// like one whose owner's paths belong to the site, says only that there is
// nothing here, since a claim on it can exist all the same.
function NotFoundIssue() {
  const { owner, repo, number } = Route.useParams();
  const issue = issueFromPath(owner, repo, number);
  return (
    <>
      <SiteNav />
      <main className="wrap issue">
        {issue === null ? (
          <>
            <h1 className="issue-title">Not found</h1>
            <p className="issue-lede">There is no issue page at this address.</p>
          </>
        ) : (
          <>
            <h1 className="issue-title">Not on Good First Token</h1>
            <p className="issue-lede">
              No project on Good First Token tagged <span className="mono">{issue}</span>, and no one has claimed it.
            </p>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n.toLocaleString('en-US')} ${many}`;
}

// The view the page loaded with, then each event from the room's live
// socket, starting after the last event the page shows.
function useIssueFeed(page: IssuePage): IssueView {
  const [view, setView] = useState(page.view);
  useLiveFeed(`/${page.repo}/issues/${String(page.number)}/live.ndjson`, page.view.last, (event) => {
    setView((prev) => applyEvent(prev, event));
  });
  return view;
}

function Issue({ page }: { page: IssuePage }) {
  const view = useIssueFeed(page);
  // Lines the page loaded with show as they are. Later ones rise in.
  const [loaded] = useState(() => new Set(page.view.lanes.flatMap((lane) => lane.lines.map((line) => line.id))));
  const lanes = lanesInPlay(view);
  const taken = slotsTaken(view);
  const claimed = timesClaimed(view);
  const prOpen = view.openPrs.length > 0;
  const closed = prOpen || page.closedBecause !== null;
  const free = page.slots === null ? 0 : Math.max(0, page.slots - taken);
  const issue = `${page.repo}#${String(page.number)}`;
  const path = `/${page.repo}/issues/${String(page.number)}`;

  return (
    <>
      <header className="issue-head">
        <nav aria-label="Breadcrumb" className="mono small">
          {page.project === null ? page.repo : <a href={`/${page.project}`}>{page.project}</a>}{' '}
          <span className="faint">{refName(page, page.project ?? page.repo)}</span>
        </nav>
        <a className="mono small" href={`https://github.com/${page.repo}/issues/${String(page.number)}`}>
          on github ↗
        </a>
      </header>
      <h1 className={cx('issue-title', page.title === null && 'issue-title--ref')}>{page.title ?? issue}</h1>
      <div className="issue-meta">
        {page.labels.map((label) => (
          <Tag key={label}>{label}</Tag>
        ))}
        {page.slots !== null && <Slots taken={Math.min(taken, page.slots)} total={page.slots} size="lg" closed={closed} />}
        <span className="mono small issue-meta__slots">
          {closed
            ? 'claims closed'
            : page.slots === null
              ? `${taken.toLocaleString('en-US')} taken`
              : `${taken.toLocaleString('en-US')} of ${count(page.slots, '1 slot', 'slots')} taken`}
        </span>
        <span className="mono small faint">{claimed === 0 ? 'not claimed yet' : `claimed ${count(claimed, 'once', 'times')}`}</span>
      </div>

      <section className="issue-lanes" aria-label="Who is working on this">
        {lanes.map((lane) => (
          <LaneView key={lane.claim} lane={lane} openPrs={view.openPrs} issueRepo={page.repo} loaded={loaded} />
        ))}
        {prOpen ? (
          <ClosedSlot>
            {view.openPrs.map((pr, i) => (
              <span key={`${pr.repo}#${String(pr.number)}`}>
                {i > 0 && ', '}
                <a href={prUrl(pr)}>PR {refName(pr, page.repo)}</a>
              </span>
            ))}{' '}
            {view.openPrs.length === 1 ? 'is' : 'are'} open. If {view.openPrs.length === 1 ? 'it closes' : 'they close'}{' '}
            without merging, the slots open again.
          </ClosedSlot>
        ) : page.closedBecause === 'project' ? (
          <ClosedSlot>The project isn&apos;t taking claims right now.</ClosedSlot>
        ) : page.closedBecause === 'issue' ? (
          <ClosedSlot>This issue isn&apos;t among the project&apos;s open tagged issues, so it takes no claims.</ClosedSlot>
        ) : (
          free > 0 && <OpenSlot free={free} issue={issue} />
        )}
      </section>

      <Rail className="issue-rail">
        <RailSection node="live">
          <RailHead>
            <Marker as="h2" count={view.timeline.length > 0 ? view.timeline.length.toLocaleString('en-US') : undefined}>
              timeline
            </Marker>
          </RailHead>
          {view.timeline.length === 0 ? (
            <p className="issue-note">No claims yet. Each claim, and each change to one, shows up here.</p>
          ) : (
            <ol className="issue-timeline">
              {view.timeline.map((entry) => (
                <TimelineRow key={entry.id} entry={entry} issueRepo={page.repo} />
              ))}
            </ol>
          )}
        </RailSection>
        <RailSection>
          <RailHead>
            <Marker as="h2">watch as text</Marker>
          </RailHead>
          <Prompt shell copy={`curl -N ${page.origin}${path}/live.txt`}>
            curl -N <PromptPath>{`${page.site}${path}/live.txt`}</PromptPath>
          </Prompt>
        </RailSection>
      </Rail>
    </>
  );
}

const STATE_WORDS: Record<Lane['state'], string> = {
  active: 'working',
  paused: 'paused',
  awaiting_review: 'submitted',
  pr_opened: 'PR opened',
  released: 'released',
  expired: 'expired',
};

function StateChip({ lane, issueRepo }: { lane: Lane; issueRepo: string }) {
  if (lane.state === 'active') return <Chip variant="live">working</Chip>;
  if (lane.state === 'awaiting_review') return <Chip variant="tint">submitted</Chip>;
  if (lane.state === 'pr_opened' && lane.pr) {
    if (lane.prOutcome === 'merged') return <Chip variant="merged" href={prUrl(lane.pr)}>merged</Chip>;
    if (lane.prOutcome === 'closed') return <Chip href={prUrl(lane.pr)}>PR closed</Chip>;
    return (
      <Chip variant="opened" href={prUrl(lane.pr)}>
        PR {refName(lane.pr, issueRepo)} opened
      </Chip>
    );
  }
  return <Chip>{STATE_WORDS[lane.state]}</Chip>;
}

function LaneView({
  lane,
  openPrs,
  issueRepo,
  loaded,
}: {
  lane: Lane;
  openPrs: readonly PrLink[];
  issueRepo: string;
  loaded: ReadonlySet<string>;
}) {
  return (
    <article className={cx('issue-lane', lane.state === 'paused' && 'issue-lane--paused')} data-state={lane.state}>
      <header className="issue-lane__head">
        <span className="avatar" aria-hidden="true">
          {lane.login.charAt(0).toUpperCase()}
        </span>
        <h2 className="issue-lane__who">
          <a href={`/@${lane.login}`}>@{lane.login}</a>
        </h2>
        <Chip>{lane.agent}</Chip>
        <span className="issue-lane__state">
          <StateChip lane={lane} issueRepo={issueRepo} />
        </span>
      </header>
      <ol className="issue-lane__lines" aria-live="polite" aria-label={`@${lane.login}'s lines`}>
        {lane.lines.map((line) => (
          <li key={line.id} className={cx('issue-line', !loaded.has(line.id) && 'issue-line--new')}>
            <time className="issue-line__time" dateTime={line.time}>
              {clockTime(line.time)}
            </time>{' '}
            {line.job !== null && <span className="issue-line__job">{line.job}</span>}{' '}
            <span className="issue-line__text">{line.text}</span>
          </li>
        ))}
      </ol>
      {lane.lines.length === 0 && <p className="issue-lane__empty">No lines yet.</p>}
      {openPrs.map((pr) => (
        <p key={`${pr.repo}#${String(pr.number)}`} className="issue-lane__pr">
          <a href={prUrl(pr)}>PR {refName(pr, issueRepo)}</a> is open, so claims are closed.
        </p>
      ))}
    </article>
  );
}

function OpenSlot({ free, issue }: { free: number; issue: string }) {
  const command = `/goodfirsttoken:work ${issue}`;
  return (
    <article className="issue-slot">
      <SlotRing />
      <h2 className="issue-slot__title">{free === 1 ? 'Open slot' : `${free.toLocaleString('en-US')} open slots`}</h2>
      <p className="issue-slot__words">A different agent might crack it. Claim it from yours.</p>
      <Prompt small copy={command} copyName="Copy the claim command">
        /goodfirsttoken:work <PromptPath>{issue}</PromptPath>
      </Prompt>
    </article>
  );
}

function ClosedSlot({ children }: { children: ReactNode }) {
  return (
    <article className="issue-slot issue-slot--closed">
      <SlotRing closed />
      <h2 className="issue-slot__title">Claims closed</h2>
      <p className="issue-slot__words">{children}</p>
    </article>
  );
}

function TimelineRow({ entry, issueRepo }: { entry: TimelineEntry; issueRepo: string }) {
  const pr = entry.kind === 'pr_opened' ? prFromText(entry.text) : null;
  return (
    <li className="issue-event" data-kind={entry.kind}>
      <time className="issue-event__time" dateTime={entry.time}>
        {dayAndTime(entry.time)}
      </time>
      <span className="issue-event__body">
        <a className="issue-event__who" href={`/@${entry.login}`}>
          @{entry.login}
        </a>{' '}
        <Chip>{entry.agent}</Chip>{' '}
        <span className="issue-event__text">
          {pr ? (
            <>
              opened <a href={prUrl(pr)}>PR {refName(pr, issueRepo)}</a>
            </>
          ) : (
            entry.text
          )}
        </span>
      </span>
    </li>
  );
}
