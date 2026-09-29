import type { FeedEvent, ToolOutput } from '@goodfirsttoken/core';
import { followFeed, socketUrl } from '../../feed/follow';
import { toWallLine } from '../../home/live';
import type { Host } from './bridge';
import { h } from './dom';
import { expires, issueHead, link, listOf, slots } from './parts';

// The live feed view: a claim, and the lines its issue's room streams live,
// the same socket the issue page follows. claim_issue's answer shows in it,
// and so does a claim the issue cards make.

export type Claimed = ToolOutput<'claim_issue'>;

/** How many of the newest lines the view keeps. The issue page and its text stream have them all. */
const LINES = 20;

const EVENT_TEXT = ['id', 'time', 'user', 'agent', 'issue', 'claim', 'kind', 'text'] as const;

/**
 * A message from the issue's socket as a feed event, or null for anything
 * else. The room checked each event before it stored it, and the view
 * shows each field as text, so this checks only that the fields it shows
 * are there.
 */
export function eventOf(data: unknown): FeedEvent | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;
  if (!EVENT_TEXT.every((key) => typeof event[key] === 'string')) return null;
  if (event.job !== null && typeof event.job !== 'string') return null;
  if (Number.isNaN(Date.parse(event.time as string))) return null;
  return event as unknown as FeedEvent;
}

/** One event as a line on the wall, as the Wall component lays it out. */
function lineOf(event: FeedEvent): HTMLElement {
  const line = toWallLine(event);
  return h(
    'div',
    { class: 'wall-line' },
    h('span', { class: 'wall-line__time' }, line.time),
    h(
      'div',
      { class: 'wall-line__body' },
      h('span', { class: 'wall-line__who' }, `@${line.login}`),
      h('span', { class: 'chip' }, line.agent),
      event.job !== null && h('span', { class: 'chip chip--tint' }, event.job),
      h('span', { class: 'wall-line__text' }, line.text),
    ),
  );
}

/**
 * The issue's lines, newest first, followed live over the socket of its
 * text stream, `<live page>/live.ndjson`. The socket's origin is the one the
 * server named the live page with, which is the one the view's resource
 * lets it reach.
 */
export function liveWall(host: Host, liveUrl: string): HTMLElement {
  const wall = h('div', { class: 'wall view-wall', 'aria-live': 'polite' });
  const empty = h('p', { class: 'view-quiet' }, 'No lines yet.');
  const part = h(
    'div',
    { class: 'view-live' },
    h('div', { class: 'view-live__head' }, h('span', { class: 'marker marker--live' }, 'live'), link(host, liveUrl, 'watch it on the issue page')),
    empty,
    wall,
  );
  if (!URL.canParse(liveUrl)) return part;
  const page = new URL(liveUrl);
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return part;
  followFeed(socketUrl(`${page.pathname}/live.ndjson`, page.href), null, eventOf, (event) => {
    empty.remove();
    wall.insertBefore(lineOf(event), wall.firstChild);
    while (wall.children.length > LINES) wall.lastElementChild?.remove();
  });
  return part;
}

/** The claim, with its issue's live lines under it, and its slots unless the card already shows them. */
export function claimPart(host: Host, claimed: Claimed, withSlots = true): HTMLElement {
  const { claim } = claimed;
  const made = claimed.resumed ? `Resumed claim ${claim.claimId}` : `Claimed as claim ${claim.claimId}`;
  const skipped = listOf<Claimed['skipped'][number]>(claimed.skipped);
  const queued = Array.isArray(claimed.queued) ? claimed.queued.filter((pick) => typeof pick === 'string') : [];
  return h(
    'div',
    { class: 'view-claim' },
    h(
      'p',
      { class: 'view-meta' },
      withSlots && slots(claimed.slotsTaken, claimed.slots),
      h('span', null, [made, `${String(claimed.slotsTaken)} of ${String(claimed.slots)} slots taken`, expires(claim)].filter(Boolean).join(' · ')),
    ),
    skipped.length > 0 &&
      h(
        'div',
        { class: 'view-quiet' },
        h('p', null, `Skipped from the queue (${String(skipped.length)}):`),
        h('ul', { class: 'view-list' }, skipped.map((pick) => h('li', null, `${pick.issue} (${pick.code}): ${pick.message}`))),
      ),
    queued.length > 0 && h('p', { class: 'view-quiet' }, `Queued next: ${queued.join(', ')}`),
    h('p', { class: 'view-links' }, link(host, claim.url, 'the issue on GitHub')),
    liveWall(host, claim.liveUrl),
  );
}

/** claim_issue's answer: the issue, the claim, and the live lines. */
export function renderClaim(host: Host, claimed: Claimed): HTMLElement {
  return h('div', { class: 'view-item' }, issueHead(claimed.claim.issue, claimed.claim.title), claimPart(host, claimed));
}
