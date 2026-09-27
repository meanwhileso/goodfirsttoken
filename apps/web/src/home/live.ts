import type { FeedEvent } from '@goodfirsttoken/core';
import type { TokenSquare } from '../components/TokenField';
import type { WallLine } from '../components/Wall';

// How the homepage shows the home feed, on the server and in the browser
// alike: the wall's lines and the token field.

/** How many lines the wall shows, newest first. */
export const WALL_LINES = 6;

/** A feed event as a line on the wall. Times are UTC, as in the text streams. */
export function toWallLine(event: FeedEvent): WallLine {
  const hash = event.issue.lastIndexOf('#');
  return {
    id: event.id,
    time: new Date(event.time).toISOString().slice(11, 19),
    login: event.user,
    agent: event.agent,
    repo: event.issue.slice(0, hash),
    issue: Number(event.issue.slice(hash + 1)),
    text: event.text,
  };
}

// The token field is 14 by 10 squares, each lit by agent work. An event
// lights the square its ID picks, one step brighter, up to the brightest. A
// merged PR turns its square green. The server lights the field for the
// day's events the page starts with, and the page lights a square for each
// live event after that, with the same rule.

export const FIELD_COLS = 14;
export const FIELD_ROWS = 10;
const SIZE = FIELD_COLS * FIELD_ROWS;

/** A field with nothing lit. */
export function emptyField(): TokenSquare[] {
  return Array.from({ length: SIZE }, () => 0);
}

/** The square an event lights: an FNV-1a hash of its ID, so every page picks the same one. */
export function squareFor(eventId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < eventId.length; i++) {
    hash ^= eventId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SIZE;
}

/** The field after one more event, and the square it lit. */
export function light(
  squares: readonly TokenSquare[],
  event: Pick<FeedEvent, 'id' | 'kind'>,
): { squares: TokenSquare[]; index: number } {
  const index = squareFor(event.id);
  const next = [...squares];
  const current = next[index] ?? 0;
  next[index] = event.kind === 'pr_merged' || current === 'merged' ? 'merged' : (Math.min(4, current + 1) as TokenSquare);
  return { squares: next, index };
}

/** A field lit by these events, in order. */
export function fieldOf(events: readonly Pick<FeedEvent, 'id' | 'kind'>[]): TokenSquare[] {
  return events.reduce<TokenSquare[]>((squares, event) => light(squares, event).squares, emptyField());
}
