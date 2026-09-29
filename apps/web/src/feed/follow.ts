// Follows a feed live over the WebSocket every stream has on its .ndjson URL,
// like /live.ndjson (src/feed/streams.ts), from a browser. Pages follow
// theirs with useLiveFeed, and the views MCP Apps hosts show (src/mcp/views/)
// with this. It imports nothing that runs, so a view's small script can hold
// it.

/** How long the first reconnect waits. Each one after it waits twice as long. */
export const FIRST_RETRY_MS = 1000;
/** The longest wait between two reconnects. */
export const LONGEST_RETRY_MS = 30_000;
/** How long a socket has to stay open for the waits to start over. */
export const STEADY_AFTER_MS = 10_000;
// How many event IDs are remembered, so an event sent twice shows once.
const REMEMBERS = 500;

/**
 * Opens the feed's socket at `url`, a ws: or wss: URL, starting after
 * `since`, the ID of the newest event already shown, or from the feed's
 * newest events when none is. `parse` turns a message into an event, or null
 * for one that isn't. Calls `onEvent` once for each new event, in the order
 * the feed sends them. Returns a function that closes the socket for good.
 *
 * When the socket drops, it reconnects with the ID of the last event it got,
 * so nothing is missed: after about a second, then twice as long each time,
 * up to 30 seconds, with some jitter so a deploy doesn't bring every reader
 * back at once. A socket that stays open for 10 seconds starts the waits
 * over, so a feed that takes each socket and closes it at once is tried less
 * and less often.
 */
export function followFeed<E extends { id: string }>(
  url: URL,
  since: string | null,
  parse: (data: unknown) => E | null,
  onEvent: (event: E) => void,
): () => void {
  let last = since;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let steady: ReturnType<typeof setTimeout> | undefined;
  let wait = FIRST_RETRY_MS;
  let stopped = false;
  const seen = new Set<string>();

  const connect = () => {
    const at = new URL(url);
    if (last !== null) at.searchParams.set('since', last);
    const current = new WebSocket(at);
    socket = current;
    current.addEventListener('open', () => {
      steady = setTimeout(() => {
        wait = FIRST_RETRY_MS;
      }, STEADY_AFTER_MS);
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
      onEvent(event);
    });
    // A socket that fails to open closes too.
    current.addEventListener('close', () => {
      clearTimeout(steady);
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
    clearTimeout(steady);
    socket?.close(1000, 'The page closed.');
  };
}

/** The socket URL of a stream at `path`, like /live.ndjson, on the origin `base` names. */
export function socketUrl(path: string, base: string): URL {
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}
