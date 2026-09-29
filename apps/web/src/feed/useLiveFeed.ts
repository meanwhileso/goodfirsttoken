import { feedEventSchema, validate, type FeedEvent } from '@goodfirsttoken/core';
import { useEffect, useEffectEvent } from 'react';
import { followFeed, socketUrl } from './follow';

// Follows a feed live from a page, over the WebSocket every stream has on
// its .ndjson URL, like /live.ndjson (src/feed/streams.ts), with followFeed.
// Any page with a feed uses it: the homepage, and the issue, repo, person,
// and /live pages.

// A message from the feed, or null when it isn't a feed event.
function parse(data: unknown): FeedEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const event = validate(feedEventSchema, JSON.parse(data), 'event');
    return event.ok ? event.value : null;
  } catch {
    return null;
  }
}

/**
 * Opens the feed's socket at `path`, like `/live.ndjson`, starting after
 * `since`, the ID of the newest event the page already shows, or from the
 * feed's newest events when it shows none. Calls `onEvent` once for each
 * new event, in the order the feed sends them. It reconnects after a drop as
 * followFeed says, and closes the socket when the page unmounts. Nothing
 * here animates, so reduced motion is up to what shows the events.
 */
export function useLiveFeed(path: string, since: string | null, onEvent: (event: FeedEvent) => void): void {
  const handle = useEffectEvent(onEvent);
  useEffect(
    () => followFeed(socketUrl(path, window.location.href), since, parse, (event) => { handle(event); }),
    [path, since],
  );
}
