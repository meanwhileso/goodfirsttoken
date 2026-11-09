import {
  MAX_PR_DESCRIPTION,
  productName,
  REVIEW_WINDOW_MS,
  takesTrigger,
  TRIGGER_HARNESSES,
  type FollowUpRecord,
  type Interests,
  type PrFollowMode,
  type PrFollowState,
  type ReviewReason,
} from '@goodfirsttoken/core';
import { followUpSource } from '@goodfirsttoken/core/text';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { Fragment, useId, type ReactNode } from 'react';
import { noticeParams } from '../auth/notice-params';
import { SiteNav } from '../auth/SiteNav';
import { Button, ButtonLink } from '../components/Button';
import { Chip, type ChipVariant } from '../components/Chip';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Quote } from '../components/Quote';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import type { Connection } from '../mcp/connections';
import type { ReviewItem } from '../mcp/submit';
import { getMePage, type Queue } from '../me/data';
import type { FollowedPr, FollowThroughShown, WakeShown } from '../me/follow';
import {
  everyText,
  HARNESS_NAMES,
  kindText,
  LEVEL_WORDS,
  MODE_NAMES,
  nextCheckText,
  standText,
  STATE_NAMES,
  stepFor,
  stoppedCheck,
  triggerText,
  when,
} from '../me/follow-words';
import { answerMeForm } from '../me/page';
import { ME_PATH } from '../me/paths';
import accountCss from '../styles/account-page.css?url';
import { routeHead } from '../readable/head';

// The signed-in person's own page (brand/brief-website.md), which replaced
// prototype/me.html: their open PRs and how their agent follows each, the
// stalled ones first (docs/specs/follow-through.md, under Status), their
// review queue, with Open PR and, for a project
// that asks for one, a description they write, or for cleared work, the
// link to GitHub's form for its PR, their follow-through mode, wakes, and
// feed, their connected agents, each
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
  // The signed-in person's own page, which no search engine lists.
  head: ({ matches }) => routeHead(matches, { title: `Your queue · ${productName}`, path: null }, [{ rel: 'stylesheet', href: accountCss }]),
  server: {
    handlers: {
      POST: ({ request }) => answerMeForm(request),
    },
  },
  component: Me,
});

// Times show in UTC, to the minute, with when() from src/me/follow-words.ts,
// so the page reads the same on the server and in the browser.

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
  too_many_files: 'GitHub listed too many changed files or commits on the branch to check them all.',
  comparison_unread: 'GitHub did not return a diff of the branch to check.',
  reviewed_mode: 'The project asks you to read the diff before its PR opens.',
  person_written_description: 'The project asks you to write the PR description.',
  open_pr_cap: 'You had as many open PRs in the project as it allows.',
  pr_refused: "GitHub didn't open the PR when the work was submitted.",
  ready_to_open: 'It is cleared to open as a PR.',
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
        placeholder="Describe what changed and why."
      />
      <span id={note} className="mono small faint">
        The project requires a description from you. Your words go in the PR unchanged.
      </span>
    </div>
  );
}

/**
 * Pushed work cleared to open: the link to GitHub's form for its PR, which
 * comes from the clearance. When the description is too long for the link,
 * the form fills in the title alone, and the description is here to paste.
 */
function ClearedPr({ item, toOpen }: { item: ReviewItem; toOpen: NonNullable<ReviewItem['toOpen']> }) {
  const id = useId();
  return (
    <div className="queue-item__cleared">
      {toOpen.bodyInLink ? (
        <p className="small muted">GitHub&apos;s form opens with the title and description filled in.</p>
      ) : (
        <div className="account-field">
          <label htmlFor={id}>PR description to paste</label>
          <textarea id={id} className="account-textarea account-input--mono" readOnly value={toOpen.body} />
          <span className="mono small faint">
            The description is too long to fill in from a link. GitHub&apos;s form opens with the title filled in.
            Paste the description there.
          </span>
        </div>
      )}
      <p className="small muted">Good First Token records the PR once it is open.</p>
      <div className="cluster">
        <ButtonLink href={toOpen.compareUrl} variant="primary" size="sm" aria-label={`Open the PR on GitHub for ${item.issue}`}>
          Open the PR on GitHub
        </ButtonLink>
        <div className="open-in">
          <a href={item.diffUrl}>diff</a>
          <a href={item.url}>issue on GitHub</a>
        </div>
      </div>
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
      {/* Cleared work says so only while it has a PR to open. */}
      {(item.reviewReason !== 'ready_to_open' || item.toOpen !== null) && (
        <p className="small muted">{WAITS_BECAUSE[item.reviewReason]}</p>
      )}
      {item.prOnIssue !== null && (
        <p className="queue-item__warning">
          A PR is already open on this issue: <a href={item.prOnIssue.url}>{item.prOnIssue.url}</a>. Open yours if a
          second one helps.
        </p>
      )}
      {item.prFromBranch !== null ? (
        <>
          <p className="small">
            Your PR is open on GitHub: <a href={item.prFromBranch.url}>{item.prFromBranch.url}</a>. Good First Token
            records it.
          </p>
          <div className="open-in">
            <a href={item.diffUrl}>diff</a>
            <a href={item.url}>issue on GitHub</a>
          </div>
        </>
      ) : item.toOpen !== null ? (
        <ClearedPr item={item} toOpen={item.toOpen} />
      ) : item.openable ? (
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
        <Marker as="h2" count={count}>
          Submitted work
        </Marker>
      </RailHead>
      {queue.state === 'sign_in_again' ? (
        <p className="account__empty">
          GitHub rejected your saved token. Sign out and sign in again to load your queue.
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
        {`Open the PR within ${String(REVIEW_WINDOW_MS / DAY)} days of the first submission.`}
      </p>
    </RailSection>
  );
}

/**
 * Each state's chip: attention colors for what needs the person, and the
 * PR-open chip otherwise. The live chip, green, is for an agent working
 * now, while a run holds the PR's lease.
 */
const STATE_CHIPS: Record<PrFollowState, ChipVariant> = {
  stalled: 'tough',
  waiting_donor: 'tough',
  agent_on_it: 'opened',
  waiting_reviewer: 'opened',
  off: 'tint',
};

/** A reviewer's words, cut to a line or two for the latest follow-ups. */
function excerpt(text: string): string {
  return text.length <= 160 ? text : `${text.slice(0, 157).trimEnd()}...`;
}

function Question({ followUp }: { followUp: FollowUpRecord }) {
  return (
    <li className="follow-pr__question">
      <p className="mono small muted">
        {`${followUpSource(followUp)} · ${kindText(followUp)} · `}
        <a href={followUp.url}>on GitHub</a>
      </p>
      <Quote>{followUp.body}</Quote>
      <p className="small">
        <span className="strong">Your agent asks:</span> {followUp.question}
      </p>
    </li>
  );
}

function Latest({ followUp }: { followUp: FollowUpRecord }) {
  return (
    <li className="follow-pr__latest">
      <span className="mono small muted">
        {`${followUpSource(followUp)} · ${kindText(followUp)} · `}
        <span className="strong">{standText(followUp)}</span>
        {followUp.replyUrl !== null && (
          <>
            {' · '}
            <a href={followUp.replyUrl}>reply</a>
          </>
        )}
        {' · '}
        <a href={followUp.url}>on GitHub</a>
      </span>
      <span className="small muted follow-pr__excerpt">{excerpt(followUp.body)}</span>
    </li>
  );
}

const PR_MODES: PrFollowMode[] = ['go_ahead', 'ask_first', 'off'];

function FollowedPrItem({ pr, now }: { pr: FollowedPr; now: number }) {
  const titleId = useId();
  const modeId = useId();
  const step = stepFor(pr);
  const next = nextCheckText(pr, now);
  const [repo, number] = pr.issue.split('#');
  const prName = `PR #${String(pr.pr.number)}`;
  return (
    <li className="follow-pr" aria-labelledby={titleId}>
      <div className="queue-item__head">
        <span id={titleId}>
          <a className="queue-item__title" href={pr.pr.url}>
            {prName}
          </a>{' '}
          <a className="mono small" href={`/${repo ?? ''}/issues/${number ?? ''}`}>
            {pr.issue}
          </a>
        </span>
        <Chip variant={pr.leased ? 'live' : STATE_CHIPS[pr.state]}>{STATE_NAMES[pr.state]}</Chip>
      </div>
      {step !== null && (
        <p className={pr.state === 'stalled' || pr.state === 'waiting_donor' ? 'queue-item__warning' : 'small muted'}>{step}</p>
      )}
      {pr.questions.length > 0 && (
        <ul className="follow-pr__questions">
          {pr.questions.map((followUp) => (
            <Question key={followUp.commentId} followUp={followUp} />
          ))}
        </ul>
      )}
      {pr.lastSubmit !== null && (
        <div className="stack follow-pr__submit">
          <span className="mono small faint">{`your agent's latest submit, ${when(pr.lastSubmit.at)}`}</span>
          <Quote>{pr.lastSubmit.summary}</Quote>
        </div>
      )}
      {pr.latest.length > 0 ? (
        <div className="stack follow-pr__latest-list">
          <span className="mono small faint">latest follow-ups</span>
          <ul>
            {pr.latest.map((followUp) => (
              <Latest key={followUp.commentId} followUp={followUp} />
            ))}
          </ul>
        </div>
      ) : (
        pr.questions.length === 0 && <p className="small muted">No follow-ups yet.</p>
      )}
      <p className="mono small faint">
        {`${MODE_NAMES[pr.followMode]}${pr.ownMode ? ', set for this PR' : ', your mode'}${next === null ? '' : ` · ${next}`}`}
      </p>
      <div className="cluster follow-pr__forms">
        <form method="post" action={ME_PATH} className="cluster follow-pr__mode">
          <input type="hidden" name="action" value="pr_follow_mode" />
          <input type="hidden" name="claim" value={pr.claimId} />
          <label htmlFor={modeId} className="mono small">
            follow
          </label>
          <select id={modeId} name="mode" className="account-input account-input--mono follow-pr__select" defaultValue={pr.followMode}>
            {PR_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_NAMES[mode]}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" aria-label={`Save how ${prName} is followed`}>
            Save
          </Button>
        </form>
        {pr.roundLimit !== null && pr.followMode !== 'off' && (
          <form method="post" action={ME_PATH}>
            <input type="hidden" name="action" value="go_on" />
            <input type="hidden" name="claim" value={pr.claimId} />
            <Button type="submit" variant="primary" size="sm" aria-label={`Go on with ${prName}`}>
              Go on
            </Button>
          </form>
        )}
      </div>
    </li>
  );
}

function OpenPrs({ follow, now }: { follow: FollowThroughShown; now: number }) {
  return (
    <RailSection>
      <RailHead>
        <Marker as="h2" count={follow.prs.length}>
          Open PRs
        </Marker>
      </RailHead>
      <ul className="queue">
        {follow.prs.map((pr) => (
          <FollowedPrItem key={pr.claimId} pr={pr} now={now} />
        ))}
      </ul>
    </RailSection>
  );
}

/**
 * A wake's trigger: whether it is on, its host, and when it last fired,
 * never its URL or key, with the form that saves one, and Turn off. The key
 * goes from the harness to this form, never through the agent.
 */
function WakeTrigger({ wake }: { wake: WakeShown }) {
  const id = useId();
  if (!takesTrigger(wake.harness)) return null;
  const harness = HARNESS_NAMES[wake.harness];
  const trigger = wake.trigger;
  const hidden = (action: string) => (
    <>
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="wake" value={wake.id} />
    </>
  );
  return (
    <div className="stack follow-trigger">
      <span className={trigger !== null && !trigger.on ? 'queue-item__warning' : 'small muted'}>{triggerText(trigger, wake.harness)}</span>
      {trigger !== null && (
        <div className="cluster follow-trigger__buttons">
          {!trigger.on && trigger.off === 'failures' && trigger.hasKey && (
            <form method="post" action={ME_PATH}>
              {hidden('trigger_on')}
              <Button type="submit" size="sm" aria-label={`Turn the ${harness} trigger on again`}>
                Turn on again
              </Button>
            </form>
          )}
          <form method="post" action={ME_PATH}>
            {hidden('remove_trigger')}
            <Button type="submit" variant="danger" size="sm" aria-label={`Turn off the ${harness} trigger`}>
              Turn off
            </Button>
          </form>
        </div>
      )}
      <details className="account__edit">
        <summary className="mono small">{trigger === null ? 'set up a trigger' : 'paste a new trigger'}</summary>
        <form method="post" action={ME_PATH} className="account__form" autoComplete="off">
          {hidden('save_trigger')}
          <div className="account-field">
            <label htmlFor={`${id}-url`}>the trigger&apos;s URL</label>
            <input
              id={`${id}-url`}
              name="url"
              type="url"
              required
              className="account-input account-input--mono"
              placeholder={TRIGGER_HARNESSES[wake.harness].form}
            />
          </div>
          <div className="account-field">
            <label htmlFor={`${id}-key`}>its key</label>
            <input id={`${id}-key`} name="key" type="password" required autoComplete="off" className="account-input account-input--mono" />
          </div>
          <Button type="submit" size="sm">
            Save trigger
          </Button>
        </form>
        <p className="small muted account__note">
          {`With a trigger, a run starts soon after a follow-up comes, and the schedule stays. Make one for this wake in ${harness}, then paste its URL and key here. Keep the key out of your agent's session. It only starts a run in ${harness}. Good First Token calls it at most once in 15 minutes, and never shows the key again.`}
        </p>
      </details>
    </div>
  );
}

function WakeItem({ wake }: { wake: WakeShown }) {
  const harness = HARNESS_NAMES[wake.harness];
  return (
    <li className="account__agent follow-wake" id={`wake-${wake.id}`}>
      <div className="stack follow-wake__about">
        <span>
          <span className="strong">{harness}</span> <Chip variant="tint">{wake.level}</Chip>
        </span>
        <span className="small muted">{LEVEL_WORDS[wake.level]}</span>
        <span className="mono small faint">
          {`${everyText(wake.intervalMinutes)} · ${wake.lastRunAt === null ? 'no run yet' : `last ran ${when(wake.lastRunAt)}`}`}
        </span>
        {wake.stopped && (
          <span className="queue-item__warning">
            {`${wake.lastRunAt === null ? `No run since you saved it on ${when(wake.createdAt)}.` : `No run since ${when(wake.lastRunAt)}.`} ${stoppedCheck(wake.harness)}`}
          </span>
        )}
        {takesTrigger(wake.harness) && wake.level !== 'session' && <WakeTrigger wake={wake} />}
      </div>
      <form method="post" action={ME_PATH}>
        <input type="hidden" name="action" value="remove_wake" />
        <input type="hidden" name="wake" value={wake.id} />
        <Button type="submit" variant="danger" size="sm" aria-label={`Remove the ${harness} wake`}>
          Remove
        </Button>
      </form>
    </li>
  );
}

function FollowThroughSection({ follow, login }: { follow: FollowThroughShown; login: string }) {
  const id = useId();
  const feed = `/@${login}/live.ndjson`;
  return (
    <section className="account__section stack" aria-label="follow-through">
      <Marker as="h2">follow-through</Marker>
      <form method="post" action={ME_PATH} className="account__form follow-mode">
        <input type="hidden" name="action" value="follow_mode" />
        <fieldset className="stack follow-mode__choices">
          <legend className="mono small">how your agent follows your PRs</legend>
          <label htmlFor={`${id}-go`} className="follow-mode__choice">
            <input id={`${id}-go`} type="radio" name="mode" value="go_ahead" defaultChecked={follow.mode.mode === 'go_ahead'} />
            <span>
              <span className="strong">go ahead</span>
              <br />
              <span className="small muted">
                Your agent answers reviewers, pushes fixes, and replies on GitHub as you. Then it tells you what it did.
                Scheduled runs spend your tokens.
              </span>
            </span>
          </label>
          <label htmlFor={`${id}-ask`} className="follow-mode__choice">
            <input id={`${id}-ask`} type="radio" name="mode" value="ask_first" defaultChecked={follow.mode.mode === 'ask_first'} />
            <span>
              <span className="strong">ask first</span>
              <br />
              <span className="small muted">Your agent tells you what came in, and you decide together what to do.</span>
            </span>
          </label>
        </fieldset>
        <Button type="submit" size="sm">
          Save
        </Button>
      </form>
      <p className="small muted account__note">
        {follow.mode.chosen ? '' : "You haven't chosen, so your PRs follow go ahead. "}
        Saving replaces the mode set for one PR. A PR you stopped following stays stopped.
      </p>
      <Marker as="h3">wakes</Marker>
      {follow.wakes.length === 0 ? (
        <p className="small muted">No wakes. Your agent follows your PRs when you start a session.</p>
      ) : (
        <ul className="account__agents">
          {follow.wakes.map((wake) => (
            <WakeItem key={wake.id} wake={wake} />
          ))}
        </ul>
      )}
      <p className="small muted account__note">Removing a wake here doesn&apos;t turn its schedule off. Turn it off in the harness too.</p>
      <Marker as="h3">your feed</Marker>
      <p className="small">
        Your agent posts what it does on each PR to your feed: <a href={feed}>{feed}</a>
      </p>
    </section>
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
        Your agent uses these interests to suggest issues. Separate entries with commas.
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
        <h1 className="account__title">Your queue</h1>
        <p className="lede account__lede">Signed in as @{viewer.login}.</p>
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
            {page.follow !== null && page.follow.prs.length > 0 && <OpenPrs follow={page.follow} now={page.now} />}
            <ReadyToOpen queue={page.queue} now={page.now} />
          </Rail>
          <aside className="account__aside">
            {page.follow === null ? (
              <p className="account__empty account__section">Your open PRs can&apos;t be read right now. Load the page again in a minute.</p>
            ) : (
              (page.follow.prs.length > 0 || page.follow.wakes.length > 0) && (
                <FollowThroughSection follow={page.follow} login={page.login} />
              )
            )}
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
                Signing out revokes your saved GitHub token. It signs you out in every browser.
              </p>
            </section>
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
