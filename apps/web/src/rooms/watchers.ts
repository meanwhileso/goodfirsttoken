import { blockedAmong } from '../db/blocks';
import { doNotListedAmong } from '../db/do-not-list';

// The people watching an issue room or a feed, over WebSockets with the
// hibernation API. The room and the feed store their events in order, and
// each watcher's socket carries the place of the last event it was sent, so
// every event reaches every watcher once, in order, whichever call sends it.
//
// Events of blocked donors are left out, and so are events on issues in a
// repo the do-not-list covers. Who is blocked, and what the list covers, is
// read from D1 each time events go out, so a block or a new entry on the
// list hides what a watcher is sent from then on, the history already stored
// included.

/** An event as a room or a feed stores it. */
export interface StoredEvent {
  /** Its place in the order the room or feed stored it. */
  seq: number;
  /** The GitHub ID of the claimant whose claim it is about. */
  githubId: number;
  /** The repo the event's issue is in, in lower case. */
  repo: string;
  /** The feed event, as JSON. */
  json: string;
}

/** What D1 says to hide: blocked donors, and repos the do-not-list covers, in lower case. */
export interface Hidden {
  donors: Set<number>;
  repos: Set<string>;
}

/** Nothing to hide, or nothing asked about yet. */
export function noneHidden(): Hidden {
  return { donors: new Set(), repos: new Set() };
}

/** The repo of an issue like `owner/name#12`, in lower case. */
export function repoOfIssue(issue: string): string {
  return issue.slice(0, issue.lastIndexOf('#')).toLowerCase();
}

/**
 * Which of these events' donors are blocked, and which of their repos the
 * do-not-list covers. Throws when D1 can't say.
 */
export async function hiddenFor(db: D1Database, events: readonly StoredEvent[]): Promise<Hidden> {
  const [donors, repos] = await Promise.all([
    blockedAmong(
      db,
      events.map((event) => event.githubId),
    ),
    doNotListedAmong(
      db,
      events.map((event) => event.repo),
    ),
  ]);
  return { donors, repos };
}

/** True when a watcher may see the event: its donor isn't blocked, and the do-not-list doesn't cover its repo. */
export function shows(event: StoredEvent, hidden: Hidden): boolean {
  return !hidden.donors.has(event.githubId) && !hidden.repos.has(event.repo);
}

/**
 * Asks D1 about the donors and repos that `known` hasn't asked about yet,
 * adds what it says to `hidden`, and adds them to `known`. False when every
 * one was asked about already, so nothing was asked. Throws when D1 can't
 * say.
 */
export async function learnHidden(
  db: D1Database,
  asked: { donors: Iterable<number>; repos: Iterable<string> },
  known: Hidden,
  hidden: Hidden,
): Promise<boolean> {
  const donors = [...new Set(asked.donors)].filter((id) => !known.donors.has(id));
  const repos = [...new Set(asked.repos)].filter((repo) => !known.repos.has(repo));
  if (donors.length === 0 && repos.length === 0) return false;
  const [blocked, listed] = await Promise.all([blockedAmong(db, donors), doNotListedAmong(db, repos)]);
  for (const id of blocked) hidden.donors.add(id);
  for (const repo of listed) hidden.repos.add(repo);
  for (const id of donors) known.donors.add(id);
  for (const repo of repos) known.repos.add(repo);
  return true;
}

/** The donors and repos of some events, to ask D1 about. */
export function askedOf(events: readonly StoredEvent[]): { donors: number[]; repos: string[] } {
  return { donors: events.map((event) => event.githubId), repos: events.map((event) => event.repo) };
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
 * Opens a WebSocket for a new watcher. `history(hidden)` gives the events to
 * send first, leaving out any it likes of the donors and repos it is told to
 * hide, and `last` the place of the last event stored.
 *
 * What to hide is read before the socket is accepted. D1 is asked about
 * each donor and repo in the history not yet asked about, and the history
 * is read again, until none in it is new. Then the socket is accepted, sent
 * its history, and given its place with no await in between, so no event
 * can fall between the history and the live events. When D1 can't say what
 * to hide, the answer is 503 and nothing is sent.
 */
export async function openWatcher(
  ctx: DurableObjectState,
  db: D1Database,
  { history, last }: { history: (hidden: Hidden) => StoredEvent[]; last: () => number },
): Promise<Response> {
  const known = noneHidden();
  const hidden = noneHidden();
  for (;;) {
    const events = history(hidden);
    // Events can arrive during this await. The loop reads the history again,
    // and asks about any donor or repo it hasn't asked about yet.
    let learned: boolean;
    try {
      learned = await learnHidden(db, askedOf(events), known, hidden);
    } catch (error) {
      console.warn('A watcher was turned away, because D1 could not say which events to hide.', error);
      return new Response('Try again in a moment.\n', { status: 503 });
    }
    if (!learned) {
      const { 0: client, 1: server } = new WebSocketPair();
      ctx.acceptWebSocket(server);
      for (const event of events) {
        if (shows(event, hidden)) server.send(event.json);
      }
      server.serializeAttachment({ after: last() } satisfies Cursor);
      return new Response(null, { status: 101, webSocket: client });
    }
  }
}

/**
 * Sends each watcher the events stored since the last one it was sent,
 * leaving out blocked donors' events and events in repos the do-not-list
 * covers. `after(seq)` gives the stored events after that place, oldest
 * first.
 *
 * It sends only the events stored before it asks D1 what to hide. An event
 * stored during that await is sent by the call that stored it. Returns the
 * lowest place any watcher is at once it is done, which is past every event
 * stored when there is no watcher. When D1 can't say what to hide, nothing
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
  let hidden: Hidden;
  try {
    hidden = await hiddenFor(db, events);
  } catch (error) {
    console.warn('New events wait for the next send, because D1 could not say which events to hide.', error);
    return null;
  }
  // A socket accepted during the await has its place already.
  for (const socket of ctx.getWebSockets()) {
    const from = cursorOf(socket);
    if (from >= upTo) continue;
    for (const event of events) {
      if (event.seq > from && shows(event, hidden)) send(socket, event.json);
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

/**
 * Closes a watcher's socket that sent a message, with 1008. Watchers only
 * listen, and each message would wake the room or feed.
 */
export function closeSender(socket: WebSocket): void {
  try {
    socket.close(1008, 'Watchers only listen.');
  } catch {
    // It closed already.
  }
}
