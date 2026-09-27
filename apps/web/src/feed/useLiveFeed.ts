import type { FeedEvent } from '@goodfirsttoken/core';
import { useEffect, useEffectEvent } from 'react';

// Follows a feed live from a page, over the WebSocket every stream has on
// its .ndjson URL, like /live.ndjson (src/feed/streams.ts). Any page with a
// feed uses it: the homepage, and the issue, repo, person, and /live pages.

/** How long the first reconnect waits. Each one after it waits twice as long. */
export const FIRST_RETRY_MS = 1000;
/** The longest wait between two reconnects. */
export const LONGEST_RETRY_MS = 30_000;
// How many event IDs are remembered, so an event sent twice shows once.
const REMEMBERS = 500;

const TEXT_FIELDS = ['id', 'time', 'user', 'agent', 'issue', 'claim', 'kind', 'text'] as const;

// A message from the feed, or null when it isn't a feed event. The feed
// checked each event with core's schema when it stored it, so this only
// guards the page against a message of another shape.
function parse(data: unknown): FeedEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as Record<string, unknown> | null;
    if (typeof value !== 'object' || value === null) return null;
    if (TEXT_FIELDS.some((field) => typeof value[field] !== 'string')) return null;
    if (value.job !== null && typeof value.job !== 'string') return null;
    return value as unknown as FeedEvent;
  } catch {
    return null;
  }
}

/**
 * Opens the feed's socket at `path`, like `/live.ndjson`, starting after
 * `since`, the ID of the newest event the page already shows, or from the
 * feed's newest events when it shows none. Calls `onEvent` once for each
 * new event, in the order the feed sends them.
 *
 * When the socket drops, it reconnects with the ID of the last event it
 * got, so nothing is missed: after about a second, then twice as long each
 * time, up to 30 seconds, with some jitter so a deploy doesn't bring every
 * page back at once. A socket that opens starts the waits over. The socket
 * closes when the page unmounts. Nothing here animates, so reduced motion is
 * up to what shows the events.
 */
export function useLiveFeed(path: string, since: string | null, onEvent: (event: FeedEvent) => void): void {
  const handle = useEffectEvent(onEvent);
  useEffect(() => {
    let last = since;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = FIRST_RETRY_MS;
    let stopped = false;
    const seen = new Set<string>();

    const connect = () => {
      const url = new URL(path, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (last !== null) url.searchParams.set('since', last);
      const current = new WebSocket(url);
      socket = current;
      current.addEventListener('open', () => {
        wait = FIRST_RETRY_MS;
      });
      current.addEventListener('message', ({ data }) => {
        const event = parse(data);
        if (event === null || seen.has(event.id)) return;
        seen.add(event.id);
        if (seen.size > REMEMBERS) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        last = event.id;
        handle(event);
      });
      // A socket that fails to open closes too.
      current.addEventListener('close', () => {
        if (stopped || socket !== current) return;
        socket = null;
        timer = setTimeout(connect, wait * (0.5 + Math.random() / 2));
        wait = Math.min(wait * 2, LONGEST_RETRY_MS);
      });
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close(1000, 'The page closed.');
    };
  }, [path, since]);
}
