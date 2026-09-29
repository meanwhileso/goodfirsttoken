import { MAX_PR_DESCRIPTION, productName, REVIEW_WINDOW_MS, type Interests, type ReviewReason } from '@goodfirsttoken/core';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { Fragment, useId, type ReactNode } from 'react';
import { noticeParams } from '../auth/notice-params';
import { SiteNav } from '../auth/SiteNav';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Quote } from '../components/Quote';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import type { Connection } from '../mcp/connections';
import type { ReviewItem } from '../mcp/submit';
import { getMePage, type Queue } from '../me/data';
import { answerMeForm } from '../me/page';
import { ME_PATH } from '../me/paths';
import accountCss from '../styles/account-page.css?url';

// The signed-in person's own page (brand/brief-website.md), which replaced
// prototype/me.html: their review queue, with Open PR and, for a project
// that asks for one, a description they write, their connected agents, each
// with Disconnect, their interests, and sign-out. Its forms post to /me and
// go through the same rules as the MCP tools (src/me/page.ts). Disconnect
// posts to /auth/agents/disconnect.
export const Route = createFileRoute('/me')({
  validateSearch: (search: Record<string, unknown>): { notice?: string; sig?: string } => noticeParams(search),
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: '/sign-in' });
    return { viewer: context.viewer };
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await getMePage({ data: deps });
    if (result.state === 'signed_out') throw redirect({ to: '/sign-in' });
    return result.page;
  },
  head: () => ({
    meta: [{ title: `Your queue · ${productName}` }],
    links: [{ rel: 'stylesheet', href: accountCss }],
  }),
  server: {
    handlers: {
      POST: ({ request }) => answerMeForm(request),
    },
  },
  component: Me,
});

// Times show in UTC, to the minute, so the page reads the same on the server
// and in the browser.
function when(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How long work has before it expires, like `6 days left`, from the time the page was read. */
function timeLeft(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  const days = Math.floor(left / DAY);
  if (days >= 1) return `${String(days)} ${days === 1 ? 'day' : 'days'} left`;
  const hours = Math.floor(left / HOUR);
  if (hours >= 1) return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'} left`;
  return 'under an hour left';
}

/** Why work waits for the person, in the page's words. */
const WAITS_BECAUSE: Record<ReviewReason, string> = {
  pr_exists: 'A PR was already open on the issue when it was submitted.',
  workflow_files: 'It changes a GitHub Actions workflow file.',
  too_many_files:
    "Someone else pushed to its branch, and GitHub's comparison lists too many files to check them all for workflow files.",
  comparison_unread: "Someone else pushed to its branch, and GitHub gave no comparison to check for workflow files.",
  reviewed_mode: 'The project asks you to read the diff before its PR opens.',
  person_written_description: 'The project asks you to write the PR description.',
  open_pr_cap: 'You had as many open PRs in the project as it allows.',
  pr_refused: "GitHub didn't open the PR when the work was submitted.",
};

/**
 * Text with each http or https link in it as a link, for a notice that names
 * a PR. A full stop, comma, or closing parenthesis at a link's end stays text.
 */
function withLinks(text: string): ReactNode[] {
  return text.split(/(https?:\/\/\S+)/).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
    let end = part.length;
    while (end > 0 && '.,)'.includes(part.charAt(end - 1))) end--;
    const url = part.slice(0, end);
    return (
      <Fragment key={i}>
        <a href={url}>{url}</a>
        {part.slice(end)}
      </Fragment>
    );
  });
}

function DescriptionField() {
  const id = useId();
  const note = useId();
  return (
    <div className="account-field">
      <label htmlFor={id}>your PR description</label>
      <textarea
        id={id}
        name="description"
        className="account-textarea"
        required
        maxLength={MAX_PR_DESCRIPTION}
        aria-describedby={note}
        placeholder="What changed, and why, in your own words."
      />
      <span id={note} className="mono small faint">
        This project asks you to write it. It goes in the PR as you wrote it.
      </span>
    </div>
  );
}

function ReadyItem({ item, now }: { item: ReviewItem; now: number }) {
  const titleId = useId();
  const size =
    item.additions === null || item.deletions === null ? null : `+${String(item.additions)} −${String(item.deletions)}`;
  return (
    <li className="queue-item" aria-labelledby={titleId}>
      <div className="queue-item__head">
        <span id={titleId}>
          <span className="queue-item__title">{item.title}</span>{' '}
          <a className="mono small" href={item.liveUrl}>
            {item.issue}
          </a>
        </span>
        <span className="mono small faint">{timeLeft(item.expiresAt, now)}</span>
      </div>
      <div className="cluster small">
        {size !== null && (
          <SplitBadges>
            <SplitBadge rule="diff" value={size} />
          </SplitBadges>
        )}
        <Chip>{item.agent}</Chip>
        <span className="mono muted">{item.model}</span>
      </div>
      <Quote>{item.summary}</Quote>
      <p className="mono small muted queue-item__checks">checked: {item.checks}</p>
      <p className="small muted">{WAITS_BECAUSE[item.reviewReason]}</p>
      {item.prOnIssue !== null && (
        <p className="queue-item__warning">
          A PR is already open on this issue: <a href={item.prOnIssue.url}>{item.prOnIssue.url}</a>. Open yours if a
          second one helps.
        </p>
      )}
      {item.openable ? (
        <form method="post" action={ME_PATH} className="queue-item__form">
          <input type="hidden" name="action" value="open_pr" />
          <input type="hidden" name="claim" value={item.claimId} />
          {item.personWrittenDescription && <DescriptionField />}
          <div className="cluster">
            <Button type="submit" variant="primary" size="sm" aria-label={`Open PR for ${item.issue}`}>
              Open PR
            </Button>
            <div className="open-in">
              <a href={item.diffUrl}>diff</a>
              <a href={item.url}>issue on GitHub</a>
            </div>
          </div>
        </form>
      ) : (
        <>
          <p className="queue-item__warning">Its PR can&apos;t open now. {item.reason}</p>
          <div className="open-in">
            <a href={item.diffUrl}>diff</a>
            <a href={item.url}>issue on GitHub</a>
          </div>
        </>
      )}
    </li>
  );
}

function ReadyToOpen({ queue, now }: { queue: Queue; now: number }) {
  const count = queue.state === 'ready' && queue.items.length > 0 ? queue.items.length : undefined;
  return (
    <RailSection>
      <RailHead>
        <Marker as="h2" variant="label" count={count}>
          ready to open
        </Marker>
      </RailHead>
      {queue.state === 'sign_in_again' ? (
        <p className="account__empty">
          GitHub no longer takes the token this site holds for you, so your queue can&apos;t be read. Sign out and in
          again to see it.
        </p>
      ) : queue.state === 'unreadable' ? (
        <p className="account__empty">Your queue can&apos;t be read right now. Load the page again in a minute.</p>
      ) : queue.items.length === 0 ? (
        <p className="account__empty">Nothing to open yet.</p>
      ) : (
        <ul className="queue">
          {queue.items.map((item) => (
            <ReadyItem key={item.claimId} item={item} now={now} />
          ))}
        </ul>
      )}
      <p className="mono small faint account__note">
        {`Work your agent submits waits here until you open its PR, for ${String(REVIEW_WINDOW_MS / DAY)} days after its first submit.`}
      </p>
    </RailSection>
  );
}

function ConnectedAgents({ agents }: { agents: Connection[] }) {
  return (
    <section className="account__section stack" aria-label="connected agents">
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

const INTEREST_LISTS = [
  { name: 'languages', label: 'languages', placeholder: 'typescript, rust' },
  { name: 'projects', label: 'projects, as owner/name', placeholder: 'owner/name' },
  { name: 'kinds', label: 'kinds of work', placeholder: 'tests, docs, bugs' },
] as const;

function InterestsSection({ interests }: { interests: Interests | null }) {
  const id = useId();
  const all = interests === null ? [] : [...interests.languages, ...interests.projects, ...interests.kinds];
  return (
    <section className="account__section stack" aria-label="interests">
      <Marker as="h2">interests</Marker>
      {all.length === 0 ? (
        <p className="small muted">No interests saved yet.</p>
      ) : (
        <ul className="cluster account__interests">
          {all.map((interest, i) => (
            <li key={`${String(i)} ${interest}`}>
              <Chip variant="tint">{interest}</Chip>
            </li>
          ))}
        </ul>
      )}
      <details className="account__edit">
        <summary className="mono small">edit</summary>
        <form method="post" action={ME_PATH} className="account__form">
          <input type="hidden" name="action" value="interests" />
          {INTEREST_LISTS.map((list) => (
            <div key={list.name} className="account-field">
              <label htmlFor={`${id}-${list.name}`}>{list.label}</label>
              <input
                id={`${id}-${list.name}`}
                name={list.name}
                className="account-input account-input--mono"
                defaultValue={interests?.[list.name].join(', ') ?? ''}
                placeholder={list.placeholder}
              />
            </div>
          ))}
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </details>
      <p className="small muted account__note">
        Your agent&apos;s suggestions rank by these. Separate each one with a comma.
      </p>
    </section>
  );
}

function Me() {
  const { viewer } = Route.useRouteContext();
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav current="me" />
      <main className="wrap account account--me">
        <h1 className="account__title">@{viewer.login}</h1>
        <p className="lede account__lede">You&apos;re signed in with GitHub.</p>
        {page.notice !== null && (
          <p className="account__notice" role="status">
            {withLinks(page.notice)}{' '}
            <Link to={ME_PATH} className="mono small">
              dismiss
            </Link>
          </p>
        )}
        <div className="account__split">
          <Rail className="account__rail">
            <ReadyToOpen queue={page.queue} now={page.now} />
          </Rail>
          <aside className="account__aside">
            <ConnectedAgents agents={page.agents} />
            <InterestsSection interests={page.interests} />
            <section className="account__section stack" aria-label="github access">
              <Marker as="h2">github access</Marker>
              <SplitBadges>
                <SplitBadge rule="scope" value="public_repo" strict />
                <SplitBadge rule="private repos" value="never" />
              </SplitBadges>
            </section>
            <section className="account__section">
              <form method="post" action="/auth/sign-out">
                <Button type="submit">Sign out</Button>
              </form>
              <p className="small muted account__note">
                Signing out revokes the GitHub token this site holds for you, and signs you out in every browser.
              </p>
            </section>
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
