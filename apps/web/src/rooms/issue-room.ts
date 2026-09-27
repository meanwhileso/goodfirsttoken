import { DurableObject } from 'cloudflare:workers';
import {
  claimDeadlines,
  claimRecordSchema,
  count,
  describeProblems,
  feedEventSchema,
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

// One issue room per issue (spec sections 6 and 8). It holds every claim on
// the issue and is the lock for the claim cap. It runs each claim's timers
// with alarms, takes the claimant's updates, streams events to the people
// watching over WebSockets, and mirrors each claim to D1. The rules for one
// claim are core's nextClaimState. The rules here need every claim on the
// issue, or who is asking.
//
// Callers pass who is asking as a numeric GitHub ID. No token ever reaches
// the room, and it stores claim facts and public events only.
//
// Each method that can change a claim checks its arguments, reads the clock,
// applies the timers that are due, and does its checks and writes with no
// await in between. So no other request can land between a check and the
// write it guards, which is what makes the claim cap hold under simultaneous
// claims. Saving to D1 and setting the next alarm come after.

/** The shortest time between two posts on one claim. */
export const POST_INTERVAL_MS = 10_000;
/** How soon a save to D1 that failed is tried again. */
export const MIRROR_RETRY_MS = 60_000;

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
    last_post_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS issue_prs (
    repo TEXT NOT NULL COLLATE NOCASE,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, event TEXT NOT NULL) STRICT;
`;

type ClaimRow = {
  id: string;
  record: string;
  revision: number;
  mirrored: number;
  last_post_at: number | null;
};

interface StoredClaim {
  record: ClaimRecord;
  revision: number;
  mirrored: number;
  lastPostAt: number | null;
}

type PrRow = { repo: string; number: number; url: string };

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
   * tokens this submit's work took, as the harness estimated them. The
   * claim's estimate is the sum over its submits.
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
   * The events after the one with ID `since`, oldest first. With no `since`,
   * or one this room never sent, every event.
   */
  history(since?: string | null): FeedEvent[] {
    const from = typeof since === 'string' ? since : null;
    return this.eventsAfter(from).map((text) => mustParse(feedEventSchema, JSON.parse(text), 'event'));
  }

  /**
   * Opens a WebSocket for a watcher. `?since=<event ID>` sends the events
   * after that one first, then every new event as it happens. Without it, the
   * whole history comes first. Each message is one feed event as JSON. The
   * socket uses the hibernation API, so a quiet room can sleep with watchers
   * connected.
   */
  override fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Connect with a WebSocket.\n', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    const since = new URL(request.url).searchParams.get('since');
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    for (const event of this.eventsAfter(since)) server.send(event);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Applies the timers that are due, saves to D1 what is waiting, and sets the next alarm. */
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
    // 1005 and 1006 say no code came, and can't be sent back.
    const answer = code === 1005 || code === 1006 ? 1000 : code;
    try {
      socket.close(answer, reason);
    } catch {
      // It closed already.
    }
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

  /** Finishes a request: saves to D1 what is waiting, sets the next alarm, and returns `result`. */
  private async done<T>(now: number, result: T): Promise<T> {
    await this.mirror();
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
   * The room's issue. The first claim sets it, and a claim on another issue
   * is a caller's mistake, since each issue has its own room.
   */
  private takeIssue(issue: string): string {
    const held = this.issue();
    if (held === null) {
      this.sql.exec("INSERT INTO facts (key, value) VALUES ('issue', ?)", issue);
      return issue;
    }
    if (held.toLowerCase() !== issue.toLowerCase()) {
      throw new BadInput(`issue: this is the room for ${held}, and ${issue} has a room of its own`);
    }
    return held;
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
    for (const { record } of this.readClaims()) {
      const after = nextClaimState(record, { kind: 'tick' }, now).claim;
      if (after.state === record.state) continue;
      this.save(after);
      if (after.state === 'paused') this.emit(after, 'paused', 'paused: no update for 30 minutes', null, now);
      if (after.state === 'expired') {
        const why = after.submittedAt === null ? 'no submit within 24 hours' : 'no PR within 7 days of the submit';
        this.emit(after, 'expired', `expired: ${why}`, null, now);
      }
    }
  }

  /** Stores a new version of a claim, with the next revision. A post also restarts its 10 seconds. */
  private save(claim: ClaimRecord, { postedAt = null }: { postedAt?: number | null } = {}): void {
    const checked = mustParse(claimRecordSchema, claim, 'claim');
    this.sql.exec(
      'UPDATE claims SET record = ?, revision = revision + 1, last_post_at = COALESCE(?, last_post_at) WHERE id = ?',
      JSON.stringify(checked),
      postedAt,
      checked.id,
    );
  }

  /** Stores an event about a claim, and sends it to every watcher. */
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
    const json = JSON.stringify(event);
    this.sql.exec('INSERT INTO events (id, event) VALUES (?, ?)', event.id, json);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(json);
      } catch {
        // A socket that closed meanwhile misses the event. Its watcher gets
        // it on reconnecting with the last ID it saw.
      }
    }
  }

  private eventsAfter(since: string | null): string[] {
    const [from] =
      since === null
        ? []
        : this.sql.exec<{ seq: number }>('SELECT seq FROM events WHERE id = ?', since).toArray();
    return this.sql
      .exec<{ event: string }>('SELECT event FROM events WHERE seq > ? ORDER BY seq', from?.seq ?? 0)
      .toArray()
      .map((row) => row.event);
  }

  private readClaims(): StoredClaim[] {
    return this.sql
      .exec<ClaimRow>('SELECT id, record, revision, mirrored, last_post_at FROM claims ORDER BY seq')
      .toArray()
      .map(toStored);
  }

  private readClaim(claimId: string): StoredClaim | null {
    const [row] = this.sql
      .exec<ClaimRow>('SELECT id, record, revision, mirrored, last_post_at FROM claims WHERE id = ?', claimId)
      .toArray();
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

  /** An open PR on the issue other than the claim's own, for its claimant to hear about. */
  private prOnIssueFor(claim: ClaimRecord): PrRef | null {
    return this.issuePrs().find((pr) => claim.pr === null || !samePr(pr, claim.pr)) ?? null;
  }

  /**
   * Saves each claim D1 doesn't have at its latest revision. A save that
   * fails is sent again, with the same revision unless the claim changed
   * since. A save D1 calls stale means it already has that revision or a
   * later one.
   */
  private async mirror(): Promise<void> {
    for (const stored of this.readClaims()) {
      if (stored.mirrored >= stored.revision) continue;
      try {
        await saveClaim(this.env.DB, stored.record, stored.revision);
        this.sql.exec('UPDATE claims SET mirrored = MAX(mirrored, ?) WHERE id = ?', stored.revision, stored.record.id);
      } catch (error) {
        console.error(`Claim ${stored.record.id} was not saved to D1. The room will try again.`, error);
      }
    }
  }

  /** Sets the alarm for the next timer on any claim, or a retry of a save that failed. */
  private async schedule(now: number): Promise<void> {
    const times: number[] = [];
    for (const stored of this.readClaims()) {
      const { pausesAt, expiresAt } = claimDeadlines(stored.record);
      if (pausesAt !== null) times.push(pausesAt);
      if (expiresAt !== null) times.push(expiresAt);
      if (stored.mirrored < stored.revision) times.push(now + MIRROR_RETRY_MS);
    }
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }
}

function toStored(row: ClaimRow): StoredClaim {
  return {
    record: mustParse(claimRecordSchema, JSON.parse(row.record), 'claim'),
    revision: row.revision,
    mirrored: row.mirrored,
    lastPostAt: row.last_post_at,
  };
}
