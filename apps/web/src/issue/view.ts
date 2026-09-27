import type { FeedEvent, FeedEventKind } from '@goodfirsttoken/core';

// What the issue page shows of its room: a lane for each claim, the issue's
// timeline, and the open PRs. The server folds the room's history into it
// when the page loads, and the page folds in each event its live socket
// sends after that, with the same function, so the two always agree. It
// imports only types, so it runs the same on the server and in the page.

/** How many of a lane's newest lines it keeps. The text stream has them all. */
export const LANE_LINES = 20;

/** A claim's state, as the page follows it from the room's events. */
export type LaneState = 'active' | 'paused' | 'awaiting_review' | 'pr_opened' | 'released' | 'expired';

/** A PR, with its link. */
export interface PrLink {
  repo: string;
  number: number;
  url: string;
}

/** One line a claimant's agent posted. */
export interface LaneLine {
  id: string;
  /** ISO 8601, in UTC. */
  time: string;
  /** A subagent's job, or null for the main agent. */
  job: string | null;
  text: string;
}

/** One claim on the issue, and the lines posted to it. */
export interface Lane {
  claim: string;
  login: string;
  agent: string;
  state: LaneState;
  /** The PR the claim opened, once it has. */
  pr: PrLink | null;
  /** What became of that PR, once it merged or closed without merging. */
  prOutcome: 'merged' | 'closed' | null;
  /** The newest lines, oldest first. A claim that ended keeps none. */
  lines: LaneLine[];
}

/** A change of a claim's state, as the timeline shows it. */
export interface TimelineEntry {
  id: string;
  time: string;
  claim: string;
  login: string;
  agent: string;
  kind: FeedEventKind;
  text: string;
}

export interface IssueView {
  /** Every claim the page may show, in the order made. */
  lanes: Lane[];
  /** Every change of state on the issue, oldest first. Lines go in the lanes. */
  timeline: TimelineEntry[];
  /** The open PRs linked to the issue. While there is one, the issue takes no claims. */
  openPrs: PrLink[];
  /**
   * Claims of blocked donors. They have no lane and no line on the page, but
   * a claim holding a slot still takes it.
   */
  hidden: { claims: number; holding: number };
  /** The ID of the last event folded in, for the live socket to start after. */
  last: string | null;
}

export function emptyView(): IssueView {
  return { lanes: [], timeline: [], openPrs: [], hidden: { claims: 0, holding: 0 }, last: null };
}

const HOLDS_SLOT: ReadonlySet<LaneState> = new Set(['active', 'paused', 'awaiting_review']);
const IN_PLAY: ReadonlySet<LaneState> = new Set(['active', 'paused', 'awaiting_review', 'pr_opened']);

/** A claim that holds one of the issue's slots: working, paused, or awaiting review. */
export function holdsSlot(lane: Lane): boolean {
  return HOLDS_SLOT.has(lane.state);
}

/**
 * The lanes the page shows: claims still working, paused, awaiting review,
 * or with their PR open. A released or expired claim leaves the lanes, and
 * the timeline keeps what became of it.
 */
export function lanesInPlay(view: IssueView): Lane[] {
  return view.lanes.filter((lane) => IN_PLAY.has(lane.state));
}

/** How many slots are taken, blocked donors' claims included. */
export function slotsTaken(view: IssueView): number {
  return view.hidden.holding + view.lanes.filter(holdsSlot).length;
}

/** How many times the issue was claimed, blocked donors' claims included. */
export function timesClaimed(view: IssueView): number {
  return view.hidden.claims + view.lanes.length;
}

/** GitHub's link for a PR. */
export function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${String(number)}`;
}

/** The PR in a `pr_opened` event's text, `opened PR owner/name#57`, or null. */
export function prFromText(text: string): PrLink | null {
  const match = /^opened PR ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#([1-9][0-9]{0,9})$/.exec(text);
  if (!match) return null;
  const [, repo = '', number = ''] = match;
  return { repo, number: Number(number), url: prUrl(repo, Number(number)) };
}

export function samePr(a: Pick<PrLink, 'repo' | 'number'>, b: Pick<PrLink, 'repo' | 'number'>): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

// The state each change of state moves a claim to. A line wakes a paused
// claim, and leaves any other state as it is. A PR's merge or close leaves
// the claim's state as it is.
const MOVES_TO: Partial<Record<FeedEventKind, LaneState>> = {
  claimed: 'active',
  paused: 'paused',
  submitted: 'awaiting_review',
  pr_opened: 'pr_opened',
  released: 'released',
  expired: 'expired',
};

function withLane(view: IssueView, event: FeedEvent): { lanes: Lane[]; lane: Lane } {
  const found = view.lanes.find((lane) => lane.claim === event.claim);
  if (found) return { lanes: view.lanes, lane: found };
  // A claim's first event is its claim. One seen first by some other event
  // still gets its lane.
  const lane: Lane = {
    claim: event.claim,
    login: event.user,
    agent: event.agent,
    state: 'active',
    pr: null,
    prOutcome: null,
    lines: [],
  };
  return { lanes: [...view.lanes, lane], lane };
}

/**
 * The view after one more event from the room. An event it already has
 * changes nothing, so an event sent twice shows once.
 */
export function applyEvent(view: IssueView, event: FeedEvent, lineCap = LANE_LINES): IssueView {
  const known = view.lanes.find((lane) => lane.claim === event.claim);
  if (known?.lines.some((line) => line.id === event.id) || view.timeline.some((entry) => entry.id === event.id)) {
    return view;
  }
  const { lanes, lane } = withLane(view, event);
  let next: Lane = lane;
  let openPrs = view.openPrs;
  let timeline = view.timeline;

  if (event.kind === 'update') {
    next = {
      ...lane,
      state: lane.state === 'paused' ? 'active' : lane.state,
      lines: [...lane.lines, { id: event.id, time: event.time, job: event.job, text: event.text }].slice(-lineCap),
    };
  } else {
    const state = MOVES_TO[event.kind];
    next = { ...lane, state: state ?? lane.state };
    if (state === 'released' || state === 'expired') next.lines = [];
    if (event.kind === 'pr_opened') {
      const pr = prFromText(event.text);
      next.pr = pr;
      if (pr && !openPrs.some((open) => samePr(open, pr))) openPrs = [...openPrs, pr];
    }
    if (event.kind === 'pr_merged' || event.kind === 'pr_closed') {
      next.prOutcome = event.kind === 'pr_merged' ? 'merged' : 'closed';
      const pr = lane.pr;
      if (pr) openPrs = openPrs.filter((open) => !samePr(open, pr));
    }
    timeline = [
      ...timeline,
      { id: event.id, time: event.time, claim: event.claim, login: lane.login, agent: lane.agent, kind: event.kind, text: event.text },
    ];
  }
  return {
    ...view,
    lanes: lanes.map((l) => (l.claim === next.claim ? next : l)),
    timeline,
    openPrs,
    last: event.id,
  };
}

/** A view of these events, in order. */
export function foldEvents(events: readonly FeedEvent[], lineCap = LANE_LINES): IssueView {
  return events.reduce((view, event) => applyEvent(view, event, lineCap), emptyView());
}

/** A time as a lane shows it, like 14:02:51, in UTC as in the text streams. */
export function clockTime(time: string): string {
  return new Date(time).toISOString().slice(11, 19);
}

/** A time as the timeline shows it, like 2026-09-27 14:02, in UTC. */
export function dayAndTime(time: string): string {
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}
