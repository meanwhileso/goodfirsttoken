import { DurableObject } from 'cloudflare:workers';
import {
  claimDeadlines,
  claimRecordSchema,
  count,
  describeProblems,
  feedEventSchema,
  feedMessageSchema,
  githubId,
  holdsSlot,
  id,
  issueRef,
  jobName,
  MAX_JOB_NAME,
  MAX_RELEASE_REASON,
  MAX_UPDATE_TEXT,
  mustParse,
  newClaim,
  nextClaimState,
  prRefSchema,
  releaseReason,
  stripSecrets,
  updateText,
  validate,
  type ClaimEvent,
  type ClaimRecord,
  type FeedEvent,
  type FeedEventKind,
  type PrRef,
  type Refusal,
  type ToolOutput,
} from '@goodfirsttoken/core';
import { saveClaim } from '../db/claims';
import { newId } from '../db/shared';
import {
  answerClose,
  hiddenFor,
  openWatcher,
  repoOfIssue,
  sendToWatchers,
  shows,
  type Hidden,
  type StoredEvent,
} from './watchers';

// One issue room per issue (spec sections 6 and 8). It holds every claim on
// the issue and is the lock for the claim cap. It runs each claim's timers
// with alarms, takes the claimant's updates, streams events to the people
// watching over WebSockets, sends each event to the feed queue, and mirrors
// each claim to D1. The rules for one claim are core's nextClaimState. The
// rules here need every claim on the issue, or who is asking.
//
// Callers pass who is asking as a numeric GitHub ID. No token ever reaches
// the room, and it stores claim facts and public events only.
//
// Each method that can change a claim checks its arguments, reads the clock,
// applies the timers that are due, and does its checks and writes with no
// await in between. So no other request can land between a check and the
// write it guards, which is what makes the claim cap hold under simultaneous
// claims. Saving to D1 and setting the next alarm come after. So do sending
// events to the watchers and the feed queue, which a call's answer never
// waits for.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The shortest time between two posts on one claim. */
export const POST_INTERVAL_MS = 10_000;
/** How soon a save to D1 that failed is first tried again. Each later wait is twice as long. */
export const SAVE_RETRY_FIRST_MS = MINUTE;
/** The longest wait between two tries of a save. */
export const SAVE_RETRY_MAX_MS = HOUR;
/** How long a save can keep failing before the room gives up on it. */
export const SAVE_GIVE_UP_MS = DAY;
// The next-try time of a save the room gave up on.
const SAVE_NEVER = Number.MAX_SAFE_INTEGER;
/** How soon a send to the feed queue that failed is first tried again. Each later wait is twice as long. */
export const SEND_RETRY_FIRST_MS = MINUTE;
/** The longest wait between two tries of a send to the feed queue. */
export const SEND_RETRY_MAX_MS = HOUR;
// A batch sent to the queue holds at most 100 messages and 256 KB. An event
// is at most a few KB.
const SEND_BATCH = 50;

/** A claim to make, from the tool that checked the issue and the donor first. */
export interface ClaimRequest {
  /** The issue, like `owner/name#12`. */
  issue: string;
  /** The project's code repo. */
  project: string;
  /** The claimant's numeric GitHub ID. */
  githubId: number;
  /** The claimant's login now. */
  login: string;
  agent: string;
  /** The claimant is an admin or maintainer of the project. */
  ownProject: boolean;
  /** The commit the work starts from. */
  startCommit: string;
  /** How many people may hold the issue at once: the project's claims per issue. */
  slots: number;
}

export interface Refused {
  ok: false;
  refusal: Refusal;
}

export type ClaimResult =
  | {
      ok: true;
      claim: ClaimRecord;
      /** False when the claimant already held the issue, and this is that claim. */
      created: boolean;
      /** Slots taken on the issue, this claim's included. */
      slotsTaken: number;
      slots: number;
    }
  | Refused;

export type ChangeResult = { ok: true; claim: ClaimRecord } | Refused;

export type PostResult = ({ ok: true } & ToolOutput<'post_update'>) | Refused;

/** What the room holds: its issue, every claim in the order made, and the open PRs on the issue. */
export interface RoomSnapshot {
  issue: string | null;
  claims: ClaimRecord[];
  prs: PrRef[];
}

/** A snapshot of the room with the events a watcher may see, all of one moment. */
export interface RoomGlance extends RoomSnapshot {
  events: FeedEvent[];
}

/**
 * The room for an issue like `owner/name#12`. Repo names compare without
 * case, so every spelling of an issue reaches the same room.
 */
export function issueRoom(
  namespace: DurableObjectNamespace<IssueRoom>,
  issue: string,
): DurableObjectStub<IssueRoom> {
  return namespace.getByName(mustParse(issueRef, issue, 'issue').toLowerCase());
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS claims (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    record TEXT NOT NULL,
    revision INTEGER NOT NULL,
    mirrored INTEGER NOT NULL,
    last_post_at INTEGER,
    save_failures INTEGER NOT NULL DEFAULT 0,
    save_after INTEGER NOT NULL DEFAULT 0,
    failing_since INTEGER,
    gave_up INTEGER,
    saving_until INTEGER,
    last_try_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS issue_prs (
    repo TEXT NOT NULL COLLATE NOCASE,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS pr_outcomes (claim_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, event TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY,
    message TEXT NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL DEFAULT 0
  ) STRICT;
`;

const CLAIM_COLUMNS = `id, record, revision, mirrored, last_post_at, save_failures, save_after, failing_since,
  gave_up, saving_until, last_try_at`;

type ClaimRow = {
  id: string;
  record: string;
  revision: number;
  mirrored: number;
  last_post_at: number | null;
  save_failures: number;
  save_after: number;
  failing_since: number | null;
  gave_up: number | null;
  saving_until: number | null;
  last_try_at: number | null;
};

interface StoredClaim {
  record: ClaimRecord;
  revision: number;
  /** The highest revision D1 is known to hold. */
  mirrored: number;
  lastPostAt: number | null;
  /** Failed tries to save the claim since the last one that landed. */
  saveFailures: number;
  /** No save of the claim is tried before this time. */
  saveAfter: number;
  /** When the first of those failed tries was, or null. */
  failingSince: number | null;
  /** The revision the room gave up saving at, or null. */
  gaveUp: number | null;
  /** While a call's try of the save is out, the time other calls may try again, or null. */
  savingUntil: number | null;
}

type PrRow = { repo: string; number: number; url: string };

type OutboxRow = { seq: number; message: string; tries: number; next_try_at: number };

function refused(code: Refusal['code'], message: string): Refused {
  return { ok: false, refusal: { code, message } };
}

/**
 * A malformed argument from a caller. Every method answers it with an
 * `invalid_input` refusal that names the field, before anything changes. A
 * throw would reach the caller too, but the runtime also reports it as an
 * uncaught error in the room.
 */
class BadInput extends Error {}

/**
 * `value` checked with `schema`, or a BadInput naming each problem. A field
 * inside `value` is named from `field`, like `pr.number`.
 */
function input<S extends Parameters<typeof validate>[0]>(schema: S, value: unknown, field: string) {
  const result = validate(schema, value, field);
  if (result.ok) return result.value;
  const problems = result.problems.map((p) => (p.field === field ? p : { ...p, field: `${field}.${p.field}` }));
  throw new BadInput(describeProblems(problems));
}

function samePr(a: PrRef, b: PrRef): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

/**
 * Text with its keys and tokens replaced, cut to `max` characters. A
 * replacement can be longer than what it replaces, like a two-character
 * password in a link.
 */
function redact(text: string, max: number): string {
  return stripSecrets(text).slice(0, max);
}

function prName(pr: PrRef): string {
  return `${pr.repo}#${String(pr.number)}`;
}

export class IssueRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /**
   * Makes a claim on the issue, or says why not. A claimant who already holds
   * the issue gets that claim back, and takes no second slot. Otherwise the
   * claim is refused while a PR is open on the issue, or when every slot is
   * taken.
   */
  async claim(request: ClaimRequest): Promise<ClaimResult> {
    return this.guard(() => this.makeClaim(request));
  }

  private async makeClaim(request: ClaimRequest): Promise<ClaimResult> {
    const slots = input(count, request.slots, 'slots');
    if (slots < 1) throw new BadInput('slots: must be at least 1');
    const now = Date.now();
    const made = input(
      claimRecordSchema,
      {
        id: newId('c'),
        issue: request.issue,
        project: request.project,
        githubId: request.githubId,
        login: request.login,
        agent: request.agent,
        ownProject: request.ownProject,
        startCommit: request.startCommit,
        tokenEstimate: null,
        ...newClaim(now),
      },
      'claim',
    );
    const record = { ...made, issue: this.takeIssue(made.issue) };
    this.settle(now);

    // From here to the insert there is no await, so no other claim can land
    // between this count and the insert that relies on it.
    const holders = this.readClaims().filter((c) => holdsSlot(c.record, now));
    const own = holders.find((c) => c.record.githubId === record.githubId);
    if (own) return this.done(now, { ok: true, claim: own.record, created: false, slotsTaken: holders.length, slots });
    const [pr] = this.issuePrs();
    if (pr) {
      return this.done(
        now,
        refused('pr_exists', `${record.issue} has an open PR, ${pr.url}, so it takes no new claims. Pick another issue.`),
      );
    }
    if (holders.length >= slots) {
      return this.done(
        now,
        refused(
          'issue_full',
          `${record.issue} has no open slot: ${String(holders.length)} of ${String(slots)} are taken. Pick another issue.`,
        ),
      );
    }

    this.sql.exec(
      'INSERT INTO claims (id, record, revision, mirrored, last_post_at) VALUES (?, ?, 1, 0, NULL)',
      record.id,
      JSON.stringify(record),
    );
    this.emit(record, 'claimed', 'claimed the issue', null, now);
    return this.done(now, { ok: true, claim: record, created: true, slotsTaken: holders.length + 1, slots });
  }

  /**
   * Posts a line to a claim. Only the claimant can post, at most once every
   * 10 seconds per claim. A post that comes sooner is not stored, and says
   * how long to wait. Every post is a check-in, so it wakes a paused claim.
   * Keys and tokens in the line are replaced before it is stored or sent.
   */
  async postUpdate(request: { claimId: string; githubId: number; text: string; job?: string | null }): Promise<PostResult> {
    return this.guard(() => this.post(request));
  }

  private async post(request: { claimId: string; githubId: number; text: string; job?: string | null }): Promise<PostResult> {
    const claimId = input(id, request.claimId, 'claimId');
    const poster = input(githubId, request.githubId, 'githubId');
    const text = redact(input(updateText, request.text, 'text'), MAX_UPDATE_TEXT);
    const job = request.job == null ? null : redact(input(jobName, request.job, 'job'), MAX_JOB_NAME);
    const now = Date.now();
    this.settle(now);

    const found = this.ownClaim(claimId, poster);
    if (!found.ok) return this.done(now, found);
    const stored = found.stored;
    const ended = this.prEnded(stored.record);
    if (ended) return this.done(now, ended);
    const prOnIssue = this.prOnIssueFor(stored.record);
    const result = nextClaimState(stored.record, { kind: 'update' }, now);
    if (!result.ok) return this.done(now, { ok: false, refusal: result.refusal });

    if (stored.lastPostAt !== null && now < stored.lastPostAt + POST_INTERVAL_MS) {
      const waitSeconds = Math.ceil((stored.lastPostAt + POST_INTERVAL_MS - now) / 1000);
      return this.done(now, { ok: true, posted: false, waitSeconds, claimId, state: stored.record.state, prOnIssue });
    }
    this.save(result.claim, { postedAt: now });
    this.emit(result.claim, 'update', text, job, now);
    return this.done(now, { ok: true, posted: true, waitSeconds: null, claimId, state: result.claim.state, prOnIssue });
  }

  /**
   * Records that the claimant submitted the work. `tokenEstimate` is the
   * tokens spent on the claim since its last submit, or since it was made,
   * as the harness estimated them. The claim's estimate is the sum over its
   * submits.
   */
  async submit(request: { claimId: string; githubId: number; tokenEstimate?: number | null }): Promise<ChangeResult> {
    return this.guard(() => {
      const estimate = request.tokenEstimate == null ? null : input(count, request.tokenEstimate, 'tokenEstimate');
      return this.change(request, { kind: 'submit' }, (before, after) => ({
        claim: {
          ...after,
          tokenEstimate: estimate === null ? after.tokenEstimate : (after.tokenEstimate ?? 0) + estimate,
        },
        kind: 'submitted',
        text: before.submittedAt === null ? 'submitted the work' : 'submitted more work',
      }));
    });
  }

  /**
   * Records the PR opened for the claim's submitted work. The PR is open on
   * the issue from then on, so the issue takes no new claims.
   */
  async openPr(request: { claimId: string; githubId: number; pr: PrRef }): Promise<ChangeResult> {
    return this.guard(() => {
      const pr = input(prRefSchema, request.pr, 'pr');
      return this.change(request, { kind: 'open_pr', pr }, (_, after) => {
        // In the same step as the claim, so no claim can land in between.
        this.addIssuePr(pr);
        return { claim: after, kind: 'pr_opened', text: `opened PR ${prName(pr)}` };
      });
    });
  }

  /** Gives up the claim, with a public reason. Keys and tokens in it are replaced. */
  async release(request: { claimId: string; githubId: number; reason: string }): Promise<ChangeResult> {
    return this.guard(() => {
      const reason = redact(input(releaseReason, request.reason, 'reason'), MAX_RELEASE_REASON);
      return this.change(request, { kind: 'release', reason }, (_, after) => ({
        claim: after,
        kind: 'released',
        text: `released: ${reason}`,
      }));
    });
  }

  /**
   * Records an open PR linked to the issue on GitHub, from anyone. While one
   * is open, the issue takes no new claims, and each claimant's update
   * answers carry its link.
   */
  async prOpened(pr: PrRef): Promise<{ ok: true } | Refused> {
    return this.guard(() => {
      this.addIssuePr(input(prRefSchema, pr, 'pr'));
      return Promise.resolve({ ok: true as const });
    });
  }

  /**
   * Records that a claim's own PR merged, or closed without merging, as the
   * PR job read it on GitHub. The room forgets the PR, so the issue takes
   * claims again once no PR is open on it, and announces the outcome once,
   * with a `pr_merged` or `pr_closed` event. The claim stays `pr_opened`,
   * and takes no more posts or submits. Telling the room again changes
   * nothing. A claim the room doesn't hold with this PR is left as it is,
   * and the PR is still forgotten.
   */
  async claimPrEnded(request: { claimId: string; pr: PrRef; merged: boolean }): Promise<{ ok: true; announced: boolean } | Refused> {
    return this.guard(() => {
      const claimId = input(id, request.claimId, 'claimId');
      const pr = input(prRefSchema, request.pr, 'pr');
      if (typeof request.merged !== 'boolean') throw new BadInput('merged: must be true or false');
      const { merged } = request;
      const now = Date.now();
      this.settle(now);
      this.sql.exec('DELETE FROM issue_prs WHERE repo = ? AND number = ?', pr.repo, pr.number);
      const stored = this.readClaim(claimId);
      const claim = stored?.record;
      const announced =
        claim !== undefined &&
        claim.pr !== null &&
        samePr(claim.pr, pr) &&
        this.sql.exec('INSERT OR IGNORE INTO pr_outcomes (claim_id, state) VALUES (?, ?)', claimId, merged ? 'merged' : 'closed')
          .rowsWritten > 0;
      if (announced) {
        this.emit(
          claim,
          merged ? 'pr_merged' : 'pr_closed',
          merged ? `PR ${prName(pr)} merged` : `PR ${prName(pr)} closed without merging`,
          null,
          now,
        );
      }
      return this.done(now, { ok: true as const, announced });
    });
  }

  /**
   * Records that a claim's own PR, which the PR job told the room closed
   * without merging, is open again on GitHub, as a read found it, like when
   * a stale bot's close was undone. The claim takes posts and submits again,
   * and the PR is open on the issue again, so the issue takes no new claims.
   * A merged PR stays merged. A claim the room doesn't hold with this PR is
   * left as it is. Telling the room again changes nothing.
   */
  async claimPrReopened(request: { claimId: string; pr: PrRef }): Promise<{ ok: true; reopened: boolean } | Refused> {
    return this.guard(() => {
      const claimId = input(id, request.claimId, 'claimId');
      const pr = input(prRefSchema, request.pr, 'pr');
      const now = Date.now();
      this.settle(now);
      const claim = this.readClaim(claimId)?.record;
      const merged = this.sql.exec("SELECT 1 FROM pr_outcomes WHERE claim_id = ? AND state = 'merged'", claimId).toArray().length > 0;
      const reopened = claim !== undefined && claim.pr !== null && samePr(claim.pr, pr) && !merged;
      if (reopened) {
        this.sql.exec('DELETE FROM pr_outcomes WHERE claim_id = ?', claimId);
        this.addIssuePr(pr);
      }
      return this.done(now, { ok: true as const, reopened });
    });
  }

  /** Records that a PR linked to the issue merged or closed. */
  async prClosed(pr: PrRef): Promise<{ ok: true } | Refused> {
    return this.guard(() => {
      const { repo, number } = input(prRefSchema, pr, 'pr');
      this.sql.exec('DELETE FROM issue_prs WHERE repo = ? AND number = ?', repo, number);
      return Promise.resolve({ ok: true as const });
    });
  }

  /** Every claim as of now, in the order made, and the open PRs on the issue. */
  async snapshot(): Promise<RoomSnapshot> {
    const now = Date.now();
    this.settle(now);
    return this.done(now, {
      issue: this.issue(),
      claims: this.readClaims().map((c) => c.record),
      prs: this.issuePrs(),
    });
  }

  /**
   * The events after the one with ID `since`, oldest first, without blocked
   * donors' events, and none while the do-not-list covers the issue's repo.
   * With no `since`, or one this room never sent, every event. Throws when D1
   * can't say what to hide.
   */
  async history(since?: string | null): Promise<FeedEvent[]> {
    const from = typeof since === 'string' ? (this.placeOf(since) ?? 0) : 0;
    const events = this.storedAfter(from);
    const hidden = await hiddenFor(this.env.DB, events);
    return events
      .filter((event) => shows(event, hidden))
      .map((event) => mustParse(feedEventSchema, JSON.parse(event.json), 'event'));
  }

  /**
   * What the issue page loads with, as of one moment: its issue, every
   * claim in the order made, blocked donors' included, the open PRs on the
   * issue, and every event a watcher may see, oldest first. The timers that
   * are due apply first. The claims, the PRs, and the events are read with
   * no await between them, so no call lands in between, and a PR is in the
   * PRs exactly when its event is in the events. Null when D1 can't say what
   * to hide.
   */
  async glance(): Promise<RoomGlance | null> {
    const now = Date.now();
    this.settle(now);
    const read = {
      issue: this.issue(),
      claims: this.readClaims().map((c) => c.record),
      prs: this.issuePrs(),
    };
    const stored = this.storedAfter(0);
    await this.done(now, undefined);
    let hidden: Hidden;
    try {
      hidden = await hiddenFor(this.env.DB, stored);
    } catch (error) {
      console.warn('A glance at an issue room was turned away, because D1 could not say which events to hide.', error);
      return null;
    }
    return {
      ...read,
      events: stored
        .filter((event) => shows(event, hidden))
        .map((event) => mustParse(feedEventSchema, JSON.parse(event.json), 'event')),
    };
  }

  /**
   * Opens a WebSocket for a watcher. `?since=<event ID>` sends the events
   * after that one first, then every new event as it happens. Without it, the
   * whole history comes first. Each message is one feed event as JSON. A
   * blocked donor's events are left out, and every event while the
   * do-not-list covers the issue's repo. The socket uses the hibernation API,
   * so a quiet room can sleep with watchers connected.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Connect with a WebSocket.\n', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    const since = new URL(request.url).searchParams.get('since');
    return openWatcher(this.ctx, this.env.DB, {
      history: () => this.storedAfter(since === null ? 0 : (this.placeOf(since) ?? 0)),
      last: () => this.lastPlace(),
    });
  }

  /**
   * Applies the timers that are due, starts sending to the watchers and the
   * feed queue what is waiting, saves to D1 what is waiting, and sets the
   * next alarm.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.settle(now);
    await this.done(now, undefined);
  }

  // Watchers only listen. What they send is ignored.
  override webSocketMessage(): void {
    // Nothing to do.
  }

  /** Answers a watcher's close, so its socket finishes closing. */
  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    answerClose(socket, code, reason);
  }

  /**
   * Applies an event to the caller's own claim, and stores and announces
   * what `describe` makes of it. `describe` runs before anything is awaited.
   */
  private async change(
    request: { claimId: string; githubId: number },
    event: ClaimEvent,
    describe: (
      before: ClaimRecord,
      after: ClaimRecord,
    ) => { claim: ClaimRecord; kind: FeedEventKind; text: string },
  ): Promise<ChangeResult> {
    const claimId = input(id, request.claimId, 'claimId');
    const caller = input(githubId, request.githubId, 'githubId');
    const now = Date.now();
    this.settle(now);

    const found = this.ownClaim(claimId, caller);
    if (!found.ok) return this.done(now, found);
    const before = found.stored.record;
    const ended = event.kind === 'submit' ? this.prEnded(before) : null;
    if (ended) return this.done(now, ended);
    const result = nextClaimState(before, event, now);
    if (!result.ok) return this.done(now, { ok: false, refusal: result.refusal });
    const { claim, kind, text } = describe(before, result.claim);
    this.save(claim);
    this.emit(claim, kind, text, null, now);
    return this.done(now, { ok: true, claim });
  }

  /**
   * Runs `work`, and answers a malformed argument with an `invalid_input`
   * refusal. Every argument is checked before anything is written, so the
   * refusal means nothing changed.
   */
  private async guard<T>(work: () => Promise<T>): Promise<T | Refused> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BadInput) return refused('invalid_input', `Nothing changed.\n${error.message}`);
      throw error;
    }
  }

  /**
   * Finishes a request. It starts sending new events to the watchers and
   * the feed queue, saves to D1 what is waiting, sets the next alarm, and
   * returns `result`. Nothing waits for the sends, so a slow queue or D1
   * holds up no answer and no alarm.
   */
  private async done<T>(now: number, result: T): Promise<T> {
    void this.sendDue(now);
    void this.sendToWatchers();
    await this.mirror(now);
    await this.schedule(now);
    return result;
  }

  /** The claim with this ID, when `caller` made it. */
  private ownClaim(
    claimId: string,
    caller: number,
  ): { ok: true; stored: StoredClaim } | Refused {
    const stored = this.readClaim(claimId);
    if (!stored) return refused('not_found', `There is no claim ${claimId} on this issue.`);
    if (stored.record.githubId !== caller) {
      return refused('not_claim_owner', `Claim ${claimId} belongs to someone else. Only the person who made it can use it.`);
    }
    return { ok: true, stored };
  }

  /**
   * The room's issue. The first claim sets it, and keeps the issue's spelling
   * for events. The issue must be the one the room is named for, in lower
   * case, as `issueRoom` names it. Otherwise one issue could have claims in
   * two rooms, and two caps.
   */
  private takeIssue(issue: string): string {
    // The room compares IDs. An ID made from a name is the same wherever it
    // is made, and the check doesn't depend on ctx.id.name being set.
    if (!this.ctx.id.equals(this.env.ISSUE_ROOM.idFromName(issue.toLowerCase()))) {
      throw new BadInput(`issue: ${issue} has a room of its own, and this is another issue's room`);
    }
    const held = this.issue();
    if (held !== null) return held;
    this.sql.exec("INSERT INTO facts (key, value) VALUES ('issue', ?)", issue);
    return issue;
  }

  private issue(): string | null {
    const [row] = this.sql.exec<{ value: string }>("SELECT value FROM facts WHERE key = 'issue'").toArray();
    return row?.value ?? null;
  }

  /**
   * Moves every claim whose timer is due to its next state, and announces
   * each change: paused after 30 minutes with no update, and expired at its
   * deadline. Runs first in every request, so a late alarm never leaves a
   * claim holding a slot it lost.
   */
  private settle(now: number): void {
    const changes: { claim: ClaimRecord; kind: FeedEventKind; text: string; at: number }[] = [];
    for (const { record } of this.readClaims()) {
      const after = nextClaimState(record, { kind: 'tick' }, now).claim;
      if (after.state === record.state) continue;
      // The event carries the deadline, which a late alarm has passed.
      const { pausesAt, expiresAt } = claimDeadlines(record);
      this.save(after);
      if (after.state === 'paused') {
        changes.push({ claim: after, kind: 'paused', text: 'paused: no update for 30 minutes', at: pausesAt ?? now });
      }
      if (after.state === 'expired') {
        const why = after.submittedAt === null ? 'no submit within 24 hours' : 'no PR within 7 days of the submit';
        changes.push({ claim: after, kind: 'expired', text: `expired: ${why}`, at: expiresAt ?? now });
      }
    }
    // In the order of the deadlines, so the times in the history never go back.
    changes.sort((a, b) => a.at - b.at);
    for (const { claim, kind, text, at } of changes) this.emit(claim, kind, text, null, at);
  }

  /**
   * Stores a new version of a claim, with the next revision. A post also
   * restarts its 10 seconds. When the claim's save waits for a retry, the
   * change makes it due a minute after its last try at the latest.
   */
  private save(claim: ClaimRecord, { postedAt = null }: { postedAt?: number | null } = {}): void {
    const checked = mustParse(claimRecordSchema, claim, 'claim');
    this.sql.exec(
      `UPDATE claims SET record = ?, revision = revision + 1, last_post_at = COALESCE(?, last_post_at),
         save_after = MIN(save_after, COALESCE(last_try_at, 0) + ?)
       WHERE id = ?`,
      JSON.stringify(checked),
      postedAt,
      SAVE_RETRY_FIRST_MS,
      checked.id,
    );
  }

  /**
   * Stores an event about a claim, and beside it a message for the feed
   * queue, kept until it is sent. The end of the call sends both on.
   */
  private emit(claim: ClaimRecord, kind: FeedEventKind, text: string, job: string | null, now: number): void {
    const event = mustParse(
      feedEventSchema,
      {
        id: newId('e'),
        time: new Date(now).toISOString(),
        user: claim.login,
        agent: claim.agent,
        issue: claim.issue,
        claim: claim.id,
        kind,
        job,
        text,
      },
      'event',
    );
    const message = mustParse(
      feedMessageSchema,
      { event, githubId: claim.githubId, project: claim.project },
      'message',
    );
    const [row] = this.sql
      .exec<{ seq: number }>('INSERT INTO events (id, event) VALUES (?, ?) RETURNING seq', event.id, JSON.stringify(event))
      .toArray();
    if (!row) throw new Error(`Event ${event.id} was not stored.`);
    this.sql.exec('INSERT INTO outbox (seq, message) VALUES (?, ?)', row.seq, JSON.stringify(message));
  }

  /** Where the event with this ID sits in the room's order, or null for an ID the room never sent. */
  private placeOf(eventId: string): number | null {
    const [row] = this.sql.exec<{ seq: number }>('SELECT seq FROM events WHERE id = ?', eventId).toArray();
    return row?.seq ?? null;
  }

  private lastPlace(): number {
    const [row] = this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events').toArray();
    return row?.seq ?? 0;
  }

  /**
   * The events after a place, oldest first, each with its claimant's GitHub
   * ID and the repo its issue is in, in lower case, which the watchers'
   * checks need. Every event is about a claim the room holds.
   */
  private storedAfter(seq: number): StoredEvent[] {
    return this.sql
      .exec<{ seq: number; event: string; github_id: number; issue: string }>(
        `SELECT e.seq, e.event, json_extract(c.record, '$.githubId') AS github_id,
           json_extract(e.event, '$.issue') AS issue
         FROM events e JOIN claims c ON c.id = json_extract(e.event, '$.claim')
         WHERE e.seq > ? ORDER BY e.seq`,
        seq,
      )
      .toArray()
      .map((row) => ({ seq: row.seq, githubId: row.github_id, repo: repoOfIssue(row.issue), json: row.event }));
  }

  private readClaims(): StoredClaim[] {
    return this.sql.exec<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM claims ORDER BY seq`).toArray().map(toStored);
  }

  private readClaim(claimId: string): StoredClaim | null {
    const [row] = this.sql.exec<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = ?`, claimId).toArray();
    return row ? toStored(row) : null;
  }

  private issuePrs(): PrRef[] {
    return this.sql
      .exec<PrRow>('SELECT repo, number, url FROM issue_prs ORDER BY rowid')
      .toArray()
      .map((row) => mustParse(prRefSchema, row, 'pr'));
  }

  private addIssuePr(pr: PrRef): void {
    this.sql.exec('INSERT OR IGNORE INTO issue_prs (repo, number, url) VALUES (?, ?, ?)', pr.repo, pr.number, pr.url);
  }

  /**
   * The refusal for a post or a submit to a claim whose PR merged or closed,
   * which the PR job told the room of, or null while its PR is open.
   */
  private prEnded(claim: ClaimRecord): Refused | null {
    const [row] = this.sql.exec<{ state: string }>('SELECT state FROM pr_outcomes WHERE claim_id = ?', claim.id).toArray();
    if (!row || claim.pr === null) return null;
    const pr = claim.pr.url;
    return refused(
      'pr_closed',
      row.state === 'merged'
        ? `Claim ${claim.id}'s PR, ${pr}, merged, so the claim takes no more posts or work. Pick another issue.`
        : `Claim ${claim.id}'s PR, ${pr}, closed without merging, so the claim takes no more posts or work. While ${claim.issue} is open and tagged, it takes claims again: claim it with claim_issue to try again.`,
    );
  }

  /** An open PR on the issue other than the claim's own, for its claimant to hear about. */
  private prOnIssueFor(claim: ClaimRecord): PrRef | null {
    return this.issuePrs().find((pr) => claim.pr === null || !samePr(pr, claim.pr)) ?? null;
  }

  /**
   * Tries to save to D1, at its latest revision, each claim whose save is
   * due when the call gets here, one claim at a time. A save D1 calls stale
   * means it already has that revision or a later one. A claim whose save
   * waits for a retry, or is out in another call, is left alone.
   *
   * When a save lands, D1 is taking saves again. Each other claim waiting for
   * a retry, and each the room gave up on, is then due a minute after its
   * last try at the latest, or at once when that minute has passed. This call
   * doesn't try those. The alarm it sets at its end does. The minute keeps a
   * claim whose save can never land, like one whose claimant D1 has no
   * record of, from being tried on every save in a busy room.
   */
  private async mirror(now: number): Promise<void> {
    const due = this.readClaims()
      .filter((c) => saveDue(c, now))
      .map((c) => c.record.id);
    if (due.length === 0) return;
    // If this call dies while a save is out, schedule() never runs. This
    // alarm then brings the room back to try again a minute later.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > now + SAVE_RETRY_FIRST_MS) await this.ctx.storage.setAlarm(now + SAVE_RETRY_FIRST_MS);
    for (const claimId of due) {
      // Read again: the claim may have changed, or another call's try may be
      // out, since the list was made.
      const stored = this.readClaim(claimId);
      if (stored === null || !saveDue(stored, now)) continue;
      // Other calls leave the claim alone while this try is out. If this
      // call ends before the try does, the claim is due again a minute later.
      this.sql.exec(
        'UPDATE claims SET saving_until = ?, last_try_at = ? WHERE id = ?',
        now + SAVE_RETRY_FIRST_MS,
        now,
        claimId,
      );
      try {
        await saveClaim(this.env.DB, stored.record, stored.revision);
      } catch (error) {
        this.saveFailed(stored, now, error);
        continue;
      }
      this.sql.exec(
        `UPDATE claims SET mirrored = MAX(mirrored, ?), save_failures = 0, save_after = 0, failing_since = NULL,
           gave_up = NULL, saving_until = NULL WHERE id = ?`,
        stored.revision,
        claimId,
      );
      this.sql.exec(
        `UPDATE claims SET save_after = MIN(save_after, MAX(?, COALESCE(last_try_at, 0) + ?))
         WHERE mirrored < revision`,
        now,
        SAVE_RETRY_FIRST_MS,
      );
    }
  }

  /**
   * Plans the next try of a save that failed: after a minute, then twice as
   * long each time, up to an hour. A save that has failed for a day is given
   * up, with one error in the log, until the claim changes or another save
   * in the room lands.
   */
  private saveFailed(stored: StoredClaim, now: number, error: unknown): void {
    const claimId = stored.record.id;
    // A try after the claim changed, once the room gave up, starts the count
    // over.
    const restarted = changedSinceGiveUp(stored);
    const failures = (restarted ? 0 : stored.saveFailures) + 1;
    const since = restarted ? now : (stored.failingSince ?? now);
    console.warn(`Claim ${claimId} was not saved to D1 at revision ${String(stored.revision)}.`, error);
    if (now - since >= SAVE_GIVE_UP_MS) {
      this.sql.exec(
        `UPDATE claims SET save_failures = ?, failing_since = ?, save_after = ?, gave_up = ?, saving_until = NULL
         WHERE id = ?`,
        failures,
        since,
        SAVE_NEVER,
        stored.revision,
        claimId,
      );
      // A retry after another save landed, which fails again, logs no second
      // error.
      if (stored.gaveUp === null || restarted) {
        console.error(
          `Claim ${claimId}: the room gave up saving it to D1 after ${String(failures)} tries over a day. ` +
            `D1 keeps an older version of the claim, or none, until the claim changes or another save lands.`,
          error,
        );
      }
      return;
    }
    const wait = Math.min(SAVE_RETRY_FIRST_MS * 2 ** (failures - 1), SAVE_RETRY_MAX_MS);
    this.sql.exec(
      `UPDATE claims SET save_failures = ?, failing_since = ?, save_after = ?, gave_up = NULL, saving_until = NULL
       WHERE id = ?`,
      failures,
      since,
      now + wait,
      claimId,
    );
  }

  /**
   * Sends the events whose send is due to the feed queue, in the order the
   * room stored them, and returns when the send is done. An event never goes
   * ahead of an earlier one still waiting. Events that come due while a send
   * is out go with the next one, in the same loop. Once the sends are done,
   * the alarm is set again from what is left. A send never throws.
   */
  private async sendDue(now: number): Promise<void> {
    try {
      for (let rows = this.takeDue(now); rows.length > 0; rows = this.takeDue(Date.now())) {
        if (!(await this.send(rows))) break;
      }
      await this.schedule(Date.now());
    } catch (error) {
      console.error('Sending events to the feed queue failed.', error);
    }
  }

  /**
   * The events at the front of the outbox whose send is due, oldest first,
   * marked as out for a minute. Other calls leave them alone meanwhile, and
   * the schedule() at the end of the call counts them as due a minute from
   * now, so if the call dies while the send is out, the alarm sends them.
   */
  private takeDue(now: number): OutboxRow[] {
    const rows: OutboxRow[] = [];
    for (const row of this.sql.exec<OutboxRow>('SELECT seq, message, tries, next_try_at FROM outbox ORDER BY seq')) {
      if (row.next_try_at > now) break;
      rows.push(row);
    }
    if (rows.length > 0) {
      this.sql.exec(
        'UPDATE outbox SET next_try_at = ? WHERE seq IN (SELECT value FROM json_each(?))',
        now + SEND_RETRY_FIRST_MS,
        JSON.stringify(rows.map((row) => row.seq)),
      );
    }
    return rows;
  }

  /**
   * Sends events to the queue a batch at a time, and forgets each batch that
   * lands. When the queue refuses a batch, it and every event after it wait a
   * minute, then twice as long each try, up to an hour, and false comes back.
   */
  private async send(rows: OutboxRow[]): Promise<boolean> {
    for (let i = 0; i < rows.length; i += SEND_BATCH) {
      const batch = rows.slice(i, i + SEND_BATCH);
      try {
        await this.env.FEED_QUEUE.sendBatch(batch.map((row) => ({ body: JSON.parse(row.message) as unknown })));
      } catch (error) {
        const tries = batch[0]?.tries ?? 0;
        const wait = Math.min(SEND_RETRY_FIRST_MS * 2 ** Math.min(tries, 20), SEND_RETRY_MAX_MS);
        console.warn(`${String(rows.length - i)} events were not sent to the feed queue. The room will try again.`, error);
        this.sql.exec(
          'UPDATE outbox SET tries = tries + 1, next_try_at = ? WHERE seq IN (SELECT value FROM json_each(?))',
          Date.now() + wait,
          JSON.stringify(rows.slice(i).map((row) => row.seq)),
        );
        return false;
      }
      this.sql.exec(
        'DELETE FROM outbox WHERE seq IN (SELECT value FROM json_each(?))',
        JSON.stringify(batch.map((row) => row.seq)),
      );
    }
    return true;
  }

  /**
   * Sends new events to the watchers. When D1 can't say who is blocked, the
   * room keeps a fact saying when to try again, a minute later, which the
   * alarm counts. A try already waiting moves a minute on while this one is
   * out, so the alarm doesn't fire again and again while D1 is slow. The fact
   * is cleared only by a send that leaves every watcher at the last event
   * stored. A send that read the events before a newer one was stored, and
   * whose D1 answer came late, leaves the try for the newer one in place.
   */
  private async sendToWatchers(): Promise<void> {
    try {
      this.sql.exec(
        "UPDATE facts SET value = ? WHERE key = 'watchers_retry_at'",
        String(Date.now() + SEND_RETRY_FIRST_MS),
      );
      const reached = await sendToWatchers(this.ctx, this.env.DB, (seq) => this.storedAfter(seq));
      if (reached !== null) {
        if (reached < this.lastPlace()) return;
        const waited = this.sql.exec("DELETE FROM facts WHERE key = 'watchers_retry_at'").rowsWritten > 0;
        if (waited) await this.schedule(Date.now());
        return;
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO facts (key, value) VALUES ('watchers_retry_at', ?)",
        String(Date.now() + SEND_RETRY_FIRST_MS),
      );
      await this.schedule(Date.now());
    } catch (error) {
      console.error('Events did not reach the watchers.', error);
    }
  }

  /**
   * Sets the alarm for the next timer on any claim, the next try of a save,
   * the next try of a send to the feed queue, and the next try of a send to
   * the watchers. The first event in the outbox sets when the queue's next
   * try is, since no event goes ahead of it. A send that is out counts as due
   * a minute after it started, in case its call dies.
   */
  private async schedule(now: number): Promise<void> {
    const times: number[] = [];
    for (const stored of this.readClaims()) {
      const { pausesAt, expiresAt } = claimDeadlines(stored.record);
      if (pausesAt !== null) times.push(pausesAt);
      if (expiresAt !== null) times.push(expiresAt);
      const next = nextTry(stored);
      if (next !== null) times.push(Math.max(next, now));
    }
    const [first] = this.sql
      .exec<{ next_try_at: number }>('SELECT next_try_at FROM outbox ORDER BY seq LIMIT 1')
      .toArray();
    if (first) times.push(Math.max(first.next_try_at, now));
    for (const { value } of this.sql.exec<{ value: string }>("SELECT value FROM facts WHERE key = 'watchers_retry_at'")) {
      times.push(Math.max(Number(value), now));
    }
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }
}

/** A claim the room gave up saving, that has changed since. */
function changedSinceGiveUp(stored: StoredClaim): boolean {
  return stored.gaveUp !== null && stored.revision > stored.gaveUp;
}

/**
 * When the claim's save can next be tried: after its wait, and once no
 * other call's try is out. Null when D1 has its latest revision, or the room
 * gave up and nothing has changed since.
 */
function nextTry(stored: StoredClaim): number | null {
  if (stored.mirrored >= stored.revision) return null;
  const after = changedSinceGiveUp(stored) ? 0 : stored.saveAfter;
  if (after >= SAVE_NEVER) return null;
  return Math.max(after, stored.savingUntil ?? 0);
}

function saveDue(stored: StoredClaim, now: number): boolean {
  const next = nextTry(stored);
  return next !== null && next <= now;
}

function toStored(row: ClaimRow): StoredClaim {
  return {
    record: mustParse(claimRecordSchema, JSON.parse(row.record), 'claim'),
    revision: row.revision,
    mirrored: row.mirrored,
    lastPostAt: row.last_post_at,
    saveFailures: row.save_failures,
    saveAfter: row.save_after,
    failingSince: row.failing_since,
    gaveUp: row.gave_up,
    savingUntil: row.saving_until,
  };
}
