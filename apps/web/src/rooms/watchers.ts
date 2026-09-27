import { blockedAmong } from '../db/blocks';

// The people watching an issue room or a feed, over WebSockets with the
// hibernation API. The room and the feed store their events in order, and
// each watcher's socket carries the place of the last event it was sent, so
// every event reaches every watcher once, in order, whichever call sends it.
//
// Events of blocked donors are left out. Which donors are blocked is read
// from D1 each time events go out, so a block hides what a watcher is sent
// from then on, the history already stored included.

/** An event as a room or a feed stores it. */
export interface StoredEvent {
  /** Its place in the order the room or feed stored it. */
  seq: number;
  /** The GitHub ID of the claimant whose claim it is about. */
  githubId: number;
  /** The feed event, as JSON. */
  json: string;
}

/** What a watcher's socket carries through hibernation. */
interface Cursor {
  /** The place of the last event the watcher was sent, or passed over. */
  after: number;
}

function cursorOf(socket: WebSocket): number {
  const cursor = socket.deserializeAttachment() as Partial<Cursor> | null;
  return typeof cursor?.after === 'number' ? cursor.after : 0;
}

function send(socket: WebSocket, json: string): void {
  try {
    socket.send(json);
  } catch {
    // A socket that closed meanwhile misses the event. Its watcher gets it
    // on reconnecting with the last ID it saw.
  }
}

/**
 * Opens a WebSocket for a new watcher. `history` gives the events to send
 * first, and `last` the place of the last event stored. `tail`, when set,
 * sends only that many of the newest events the watcher may see.
 *
 * Which donors are blocked is read before the socket is accepted. Once every
 * donor in the history is known, the socket is accepted, sent its history,
 * and given its place with no await in between, so no event can fall between
 * the history and the live events. When D1 can't say who is blocked, the
 * answer is 503 and nothing is sent.
 */
export async function openWatcher(
  ctx: DurableObjectState,
  db: D1Database,
  { history, last, tail }: { history: () => StoredEvent[]; last: () => number; tail?: number },
): Promise<Response> {
  const known = new Set<number>();
  const blocked = new Set<number>();
  for (;;) {
    const events = history();
    const unknown = [...new Set(events.map((event) => event.githubId))].filter((id) => !known.has(id));
    if (unknown.length === 0) {
      const visible = events.filter((event) => !blocked.has(event.githubId));
      const { 0: client, 1: server } = new WebSocketPair();
      ctx.acceptWebSocket(server);
      for (const event of tail === undefined ? visible : visible.slice(-tail)) server.send(event.json);
      server.serializeAttachment({ after: last() } satisfies Cursor);
      return new Response(null, { status: 101, webSocket: client });
    }
    // Events can arrive during this await. The loop reads the history again,
    // and asks about any donor it hasn't asked about yet.
    try {
      for (const id of await blockedAmong(db, unknown)) blocked.add(id);
    } catch (error) {
      console.warn('A watcher was turned away, because D1 could not say which donors are blocked.', error);
      return new Response('Try again in a moment.\n', { status: 503 });
    }
    for (const id of unknown) known.add(id);
  }
}

/**
 * Sends each watcher the events stored since the last one it was sent,
 * leaving out blocked donors' events. `after(seq)` gives the stored events
 * after that place, oldest first.
 *
 * It sends only the events stored before it asks D1 who is blocked. An event
 * stored during that await is sent by the call that stored it. When D1 can't
 * say who is blocked, nothing is sent, and the events go out with the next
 * one, or when the watcher reconnects.
 */
export async function sendToWatchers(
  ctx: DurableObjectState,
  db: D1Database,
  after: (seq: number) => StoredEvent[],
): Promise<void> {
  const sockets = ctx.getWebSockets();
  if (sockets.length === 0) return;
  const events = after(Math.min(...sockets.map(cursorOf)));
  const upTo = events.at(-1)?.seq;
  if (upTo === undefined) return;
  let blocked: Set<number>;
  try {
    blocked = await blockedAmong(
      db,
      events.map((event) => event.githubId),
    );
  } catch (error) {
    console.warn('New events wait for the next send, because D1 could not say which donors are blocked.', error);
    return;
  }
  // A socket accepted during the await has its place already.
  for (const socket of ctx.getWebSockets()) {
    const from = cursorOf(socket);
    if (from >= upTo) continue;
    for (const event of events) {
      if (event.seq > from && !blocked.has(event.githubId)) send(socket, event.json);
    }
    socket.serializeAttachment({ after: upTo } satisfies Cursor);
  }
}

/** Answers a watcher's close, so its socket finishes closing. */
export function answerClose(socket: WebSocket, code: number, reason: string): void {
  // 1005 and 1006 say no code came, and can't be sent back.
  const answer = code === 1005 || code === 1006 ? 1000 : code;
  try {
    socket.close(answer, reason);
  } catch {
    // It closed already.
  }
}
