import { blockedAmong } from '../db/blocks';
import { doNotListedAmong, doNotListedClaimsAmong, doNotListedProjectsAmong } from '../db/do-not-list';

// The people watching an issue room or a feed, over WebSockets with the
// hibernation API. The room and the feed store their events in order, and
// each watcher's socket carries the place of the last event it was sent, so
// every event reaches every watcher once, in order, whichever call sends it.
//
// Events of blocked donors are left out, and so are events on issues in a
// repo the do-not-list covers, and events on claims of a project the list
// names, wherever its issues were. Who is blocked, and what the list covers,
// is read from D1 each time events go out, so a block or a new entry on the
// list hides what a watcher is sent from then on, the history already stored
// included.

/**
 * The header the Worker names a watcher's client address in, as the rate
 * limiter keys it (limiterKey), when it hands a feed or room an upgrade.
 */
export const WATCHER_ADDRESS_HEADER = 'x-gft-watcher-address';

/** How many watchers one client address can hold on one feed or room. */
export const WATCHERS_PER_ADDRESS = 100;

/** An event as a room or a feed stores it. */
export interface StoredEvent {
  /** Its place in the order the room or feed stored it. */
  seq: number;
  /** The GitHub ID of the claimant whose claim it is about. */
  githubId: number;
  /** The repo the event's issue is in, in lower case. */
  repo: string;
  /**
   * The code repo of the project the event's claim is on, in lower case.
   * Null for a feed's event stored before feeds kept it, which is judged
   * by its claim instead.
   */
  project: string | null;
  /** The ID of the claim the event is about. */
  claim: string;
  /** The feed event, as JSON. */
  json: string;
}

/**
 * What D1 says to hide: blocked donors, issue repos the do-not-list covers,
 * projects it names, both in lower case, and claims on those projects.
 */
export interface Hidden {
  donors: Set<number>;
  repos: Set<string>;
  projects: Set<string>;
  /** Claims on a project the list names, asked about only for events stored with no project. */
  claims: Set<string>;
}

/** Nothing to hide, or nothing asked about yet. */
export function noneHidden(): Hidden {
  return { donors: new Set(), repos: new Set(), projects: new Set(), claims: new Set() };
}

/** What to ask D1 about some events. */
interface Asked {
  donors: Iterable<number>;
  repos: Iterable<string>;
  projects: Iterable<string>;
  claims: Iterable<string>;
}

async function askD1(db: D1Database, asked: Asked): Promise<Hidden> {
  const [donors, repos, projects, claims] = await Promise.all([
    blockedAmong(db, asked.donors),
    doNotListedAmong(db, asked.repos),
    doNotListedProjectsAmong(db, asked.projects),
    doNotListedClaimsAmong(db, asked.claims),
  ]);
  return { donors, repos, projects, claims };
}

/** The repo of an issue like `owner/name#12`, in lower case. */
export function repoOfIssue(issue: string): string {
  return issue.slice(0, issue.lastIndexOf('#')).toLowerCase();
}

/**
 * Which of these events' donors are blocked, which of their repos the
 * do-not-list covers, and which of their projects it names. Throws when D1
 * can't say.
 */
export async function hiddenFor(db: D1Database, events: readonly StoredEvent[]): Promise<Hidden> {
  return askD1(db, askedOf(events));
}

/**
 * True when a watcher may see the event: its donor isn't blocked, the
 * do-not-list doesn't cover its issue's repo, and doesn't name its claim's
 * project. An event stored with no project is judged by its claim, which
 * D1 knows the project of.
 */
export function shows(event: StoredEvent, hidden: Hidden): boolean {
  if (hidden.donors.has(event.githubId) || hidden.repos.has(event.repo)) return false;
  return event.project === null ? !hidden.claims.has(event.claim) : !hidden.projects.has(event.project);
}

/**
 * Asks D1 about the donors, repos, projects, and claims that `known` hasn't
 * asked about yet, adds what it says to `hidden`, and adds them to `known`.
 * False when every one was asked about already, so nothing was asked.
 * Throws when D1 can't say.
 */
export async function learnHidden(db: D1Database, asked: Asked, known: Hidden, hidden: Hidden): Promise<boolean> {
  const fresh = <T>(items: Iterable<T>, seen: Set<T>) => [...new Set(items)].filter((item) => !seen.has(item));
  const donors = fresh(asked.donors, known.donors);
  const repos = fresh(asked.repos, known.repos);
  const projects = fresh(asked.projects, known.projects);
  const claims = fresh(asked.claims, known.claims);
  if (donors.length + repos.length + projects.length + claims.length === 0) return false;
  const learned = await askD1(db, { donors, repos, projects, claims });
  for (const id of learned.donors) hidden.donors.add(id);
  for (const repo of learned.repos) hidden.repos.add(repo);
  for (const project of learned.projects) hidden.projects.add(project);
  for (const claim of learned.claims) hidden.claims.add(claim);
  for (const id of donors) known.donors.add(id);
  for (const repo of repos) known.repos.add(repo);
  for (const project of projects) known.projects.add(project);
  for (const claim of claims) known.claims.add(claim);
  return true;
}

/** The donors, repos, and projects of some events, and the claims of those stored with no project, to ask D1 about. */
export function askedOf(events: readonly StoredEvent[]): {
  donors: number[];
  repos: string[];
  projects: string[];
  claims: string[];
} {
  return {
    donors: events.map((event) => event.githubId),
    repos: events.map((event) => event.repo),
    projects: events.flatMap((event) => (event.project === null ? [] : [event.project])),
    claims: events.flatMap((event) => (event.project === null ? [event.claim] : [])),
  };
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

// The answer to a client address that holds as many watchers as it may.
function tooManyWatchers(): Response {
  return new Response('Too many live streams open from here. Close one, or try again in a minute.\n', {
    status: 429,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
  });
}

/**
 * Opens a WebSocket for a new watcher. `history(hidden)` gives the events to
 * send first, leaving out any it likes of the donors, repos, projects, and
 * claims it is told to hide, and `last` the place of the last event stored.
 *
 * The upgrade names the watcher's client address in WATCHER_ADDRESS_HEADER,
 * and its socket is tagged with it. An address that already holds
 * WATCHERS_PER_ADDRESS sockets here gets 429, and no socket, so no one client
 * can fill a feed that sends each event to every socket it holds. An upgrade
 * that names no address, which only tests make, has no cap.
 *
 * What to hide is read before the socket is accepted. D1 is asked about
 * each donor, repo, project, and claim in the history not yet asked about,
 * and the history is read again, until none in it is new. Then the socket is accepted, sent
 * its history, and given its place with no await in between, so no event
 * can fall between the history and the live events. When D1 can't say what
 * to hide, the answer is 503 and nothing is sent.
 */
export async function openWatcher(
  ctx: DurableObjectState,
  db: D1Database,
  request: Request,
  { history, last }: { history: (hidden: Hidden) => StoredEvent[]; last: () => number },
): Promise<Response> {
  const address = request.headers.get(WATCHER_ADDRESS_HEADER);
  const full = () => address !== null && ctx.getWebSockets(address).length >= WATCHERS_PER_ADDRESS;
  if (full()) return tooManyWatchers();
  const known = noneHidden();
  const hidden = noneHidden();
  for (;;) {
    const events = history(hidden);
    // Events can arrive during this await. The loop reads the history again,
    // and asks about anything it hasn't asked about yet.
    let learned: boolean;
    try {
      learned = await learnHidden(db, askedOf(events), known, hidden);
    } catch (error) {
      console.warn('A watcher was turned away, because D1 could not say which events to hide.', error);
      return new Response('Try again in a moment.\n', { status: 503 });
    }
    if (!learned) {
      // Other sockets from the address may have come in during the awaits
      // above, if the runtime lets another request run while D1 answers. The
      // tests couldn't make that happen on purpose: upgrades sent together
      // were each accepted in turn. So no test holds this check, and it stays
      // for the runtime that does interleave them.
      if (full()) return tooManyWatchers();
      const { 0: client, 1: server } = new WebSocketPair();
      ctx.acceptWebSocket(server, address === null ? [] : [address]);
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
 * leaving out blocked donors' events, events in repos the do-not-list
 * covers, and events on projects it names. `after(seq)` gives the stored events after that place, oldest
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
