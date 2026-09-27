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
 * Opens a WebSocket for a new watcher. `history(blocked)` gives the events to
 * send first, leaving out any it likes of the donors it is told are blocked,
 * and `last` the place of the last event stored.
 *
 * Which donors are blocked is read before the socket is accepted. D1 is
 * asked about each donor in the history not yet asked about, and the history
 * is read again, until no donor in it is new. Then the socket is accepted,
 * sent its history, and given its place with no await in between, so no
 * event can fall between the history and the live events. When D1 can't say
 * who is blocked, the answer is 503 and nothing is sent.
 */
export async function openWatcher(
  ctx: DurableObjectState,
  db: D1Database,
  { history, last }: { history: (blocked: ReadonlySet<number>) => StoredEvent[]; last: () => number },
): Promise<Response> {
  const known = new Set<number>();
  const blocked = new Set<number>();
  for (;;) {
    const events = history(blocked);
    const unknown = [...new Set(events.map((event) => event.githubId))].filter((id) => !known.has(id));
    if (unknown.length === 0) {
      const { 0: client, 1: server } = new WebSocketPair();
      ctx.acceptWebSocket(server);
      for (const event of events) {
        if (!blocked.has(event.githubId)) server.send(event.json);
      }
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
 * stored during that await is sent by the call that stored it. Returns the
 * lowest place any watcher is at once it is done, which is past every event
 * stored when there is no watcher. When D1 can't say who is blocked, nothing
 * is sent, and it returns null, for the caller to try again.
 */
export async function sendToWatchers(
  ctx: DurableObjectState,
  db: D1Database,
  after: (seq: number) => StoredEvent[],
): Promise<number | null> {
  const lowest = () => Math.min(Number.MAX_SAFE_INTEGER, ...ctx.getWebSockets().map(cursorOf));
  const sockets = ctx.getWebSockets();
  if (sockets.length === 0) return lowest();
  const events = after(lowest());
  const upTo = events.at(-1)?.seq;
  if (upTo === undefined) return lowest();
  let blocked: Set<number>;
  try {
    blocked = await blockedAmong(
      db,
      events.map((event) => event.githubId),
    );
  } catch (error) {
    console.warn('New events wait for the next send, because D1 could not say which donors are blocked.', error);
    return null;
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
  return lowest();
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
